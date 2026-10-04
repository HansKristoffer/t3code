import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as ThreadTransferBroker from "./ThreadTransferBroker.ts";

const server = EnvironmentId.make("env-server");
const threadId = ThreadId.make("thread-1");

describe("ThreadTransferBroker", () => {
  it.effect("fails when no open client reaches the environment", () =>
    Effect.gen(function* () {
      const broker = yield* ThreadTransferBroker.make;
      const error = yield* Effect.flip(broker.request({ threadId, targetEnvironmentId: server }));
      assert.include(error.message, "No open T3 Code app");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("hands a transfer to the first carrier that claims it and returns its result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* ThreadTransferBroker.make;
        const pull = (clientId: string) =>
          broker
            .carry({ clientId, targets: [{ environmentId: server, label: "Server" }] })
            .pipe(Effect.flatMap(Stream.toPull));
        const laptop = yield* pull("laptop");
        const phone = yield* pull("phone");
        assert.deepEqual(yield* broker.targets, [{ environmentId: server, label: "Server" }]);

        const requested = yield* Effect.forkChild(
          broker.request({ threadId, targetEnvironmentId: server }),
        );
        const [offer] = yield* laptop;
        const [sameOffer] = yield* phone;
        assert.equal(offer.threadId, threadId);
        assert.equal(sameOffer.requestId, offer.requestId);
        assert.isTrue(yield* broker.claim({ requestId: offer.requestId, clientId: "laptop" }));
        // The other carrier lost the race.
        assert.isFalse(yield* broker.claim({ requestId: offer.requestId, clientId: "phone" }));

        const started = yield* Fiber.join(requested);
        assert.equal(started.transferId, offer.transferId);
        const arrived = ThreadId.make(`transfer-${offer.transferId}`);
        // Only the claimant's report counts.
        yield* broker.report({
          requestId: offer.requestId,
          clientId: "phone",
          threadId: null,
          error: "not mine",
        });
        yield* broker.report({
          requestId: offer.requestId,
          clientId: "laptop",
          threadId: arrived,
          error: null,
        });
        assert.equal(yield* started.result, arrived);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
