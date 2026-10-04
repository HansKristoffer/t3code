import {
  ThreadTransferError,
  type EnvironmentId,
  type ThreadId,
  type ThreadTransferCarrier,
  type ThreadTransferCarryRequest,
  type ThreadTransferClaimInput,
  type ThreadTransferId,
  type ThreadTransferReportInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** How long a client connected to both environments has to pick a request up. */
const CLAIM_TIMEOUT = Duration.seconds(20);
/** A claimed transfer moves the whole session; it may take a while on a slow link. */
const RESULT_TIMEOUT = Duration.minutes(30);

export interface ThreadTransferTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Lets an agent move a thread to another environment. Environments never
 * talk to each other, so a client connected to both carries every transfer.
 * Clients subscribe as carriers with the environments they can reach; a
 * request goes to every carrier that reaches its target and the first claim
 * runs it, the same way the transfer dialog does.
 */
export class ThreadTransferBroker extends Context.Service<
  ThreadTransferBroker,
  {
    /** Registers a carrier for the scope's lifetime and returns its requests. */
    readonly carry: (
      carrier: ThreadTransferCarrier,
    ) => Effect.Effect<Stream.Stream<ThreadTransferCarryRequest>, never, Scope.Scope>;
    readonly claim: (input: ThreadTransferClaimInput) => Effect.Effect<boolean>;
    readonly report: (input: ThreadTransferReportInput) => Effect.Effect<void>;
    /** Environments some open client can carry a transfer to. */
    readonly targets: Effect.Effect<ReadonlyArray<ThreadTransferTarget>>;
    /**
     * Hands a transfer to a carrier and succeeds once one claims it, with the
     * transfer id and an effect that waits for the destination's thread.
     */
    readonly request: (input: {
      readonly threadId: ThreadId;
      readonly targetEnvironmentId: EnvironmentId;
    }) => Effect.Effect<
      {
        readonly transferId: ThreadTransferId;
        readonly result: Effect.Effect<ThreadId, ThreadTransferError>;
      },
      ThreadTransferError
    >;
  }
>()("t3/threadTransfer/ThreadTransferBroker") {}

interface Carrier {
  readonly carrier: ThreadTransferCarrier;
  readonly queue: Queue.Queue<ThreadTransferCarryRequest>;
}

interface Pending {
  claimedBy: string | null;
  readonly claimed: Deferred.Deferred<void>;
  readonly result: Deferred.Deferred<ThreadId, ThreadTransferError>;
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const carriers = new Set<Carrier>();
  const pending = new Map<string, Pending>();

  const carry: ThreadTransferBroker["Service"]["carry"] = (carrier) =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ThreadTransferCarryRequest>();
      const entry = { carrier, queue };
      yield* Effect.acquireRelease(
        Effect.sync(() => carriers.add(entry)),
        () => Effect.sync(() => carriers.delete(entry)),
      );
      return Stream.fromQueue(queue);
    });

  const claim: ThreadTransferBroker["Service"]["claim"] = (input) =>
    Effect.gen(function* () {
      const entry = pending.get(input.requestId);
      if (entry === undefined || entry.claimedBy !== null) return false;
      entry.claimedBy = input.clientId;
      yield* Deferred.succeed(entry.claimed, undefined);
      return true;
    });

  const report: ThreadTransferBroker["Service"]["report"] = (input) =>
    Effect.gen(function* () {
      const entry = pending.get(input.requestId);
      if (entry === undefined || entry.claimedBy !== input.clientId) return;
      pending.delete(input.requestId);
      yield* input.threadId === null
        ? Deferred.fail(
            entry.result,
            new ThreadTransferError({ message: input.error ?? "The transfer failed." }),
          )
        : Deferred.succeed(entry.result, input.threadId);
    });

  const targets: ThreadTransferBroker["Service"]["targets"] = Effect.sync(() => {
    const byId = new Map<EnvironmentId, ThreadTransferTarget>();
    for (const { carrier } of carriers) {
      for (const target of carrier.targets) byId.set(target.environmentId, target);
    }
    return [...byId.values()];
  });

  const request: ThreadTransferBroker["Service"]["request"] = (input) =>
    Effect.gen(function* () {
      const reachable = [...carriers].filter(({ carrier }) =>
        carrier.targets.some((target) => target.environmentId === input.targetEnvironmentId),
      );
      if (reachable.length === 0) {
        return yield* new ThreadTransferError({
          message:
            "No open T3 Code app is connected to both environments. Open T3 Code on a computer connected to both and try again.",
        });
      }
      const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const transferId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)) as ThreadTransferId;
      const entry: Pending = {
        claimedBy: null,
        claimed: yield* Deferred.make<void>(),
        result: yield* Deferred.make<ThreadId, ThreadTransferError>(),
      };
      pending.set(requestId, entry);
      yield* Effect.forEach(
        reachable,
        ({ queue }) =>
          Queue.offer(queue, {
            requestId,
            threadId: input.threadId,
            transferId,
            targetEnvironmentId: input.targetEnvironmentId,
          }),
        { discard: true },
      );
      const claimed = yield* Deferred.await(entry.claimed).pipe(
        Effect.timeoutOption(CLAIM_TIMEOUT),
      );
      if (claimed._tag === "None") {
        pending.delete(requestId);
        return yield* new ThreadTransferError({
          message: "No open T3 Code app picked up the transfer. Try again.",
        });
      }
      return {
        transferId,
        result: Deferred.await(entry.result).pipe(
          Effect.timeoutOrElse({
            duration: RESULT_TIMEOUT,
            orElse: () =>
              Effect.sync(() => pending.delete(requestId)).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ThreadTransferError({
                      message:
                        "The transfer did not report back in time. Check the thread in T3 Code.",
                    }),
                  ),
                ),
              ),
          }),
        ),
      };
    });

  return ThreadTransferBroker.of({ carry, claim, report, targets, request });
});

export const layer = Layer.effect(ThreadTransferBroker, make);
