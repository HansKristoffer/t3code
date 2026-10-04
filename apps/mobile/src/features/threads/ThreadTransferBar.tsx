import type { OrchestrationV2ThreadTransferOut, ScopedThreadRef } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useServerConfigs } from "../../state/entities";
import { RequestActionButton } from "./RequestActionButton";
import { transferThreadFromMobile, unlockTransferredThread } from "./thread-transfer";

/**
 * Replaces the composer on a thread that moved, or is moving, to another
 * environment. Its copy there owns the conversation, so nothing is sent here.
 */
export function ThreadTransferBar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly transfer: OrchestrationV2ThreadTransferOut;
  readonly openThread: (ref: ScopedThreadRef) => void;
}) {
  const { transfer, threadRef, openThread } = props;
  const destination = transfer.destination;
  const destinationConfig = useServerConfigs().get(
    destination?.environmentId ?? threadRef.environmentId,
  );
  const destinationLabel =
    (destination === undefined ? undefined : destinationConfig?.environment.label) ??
    destination?.environmentLabel ??
    "another environment";
  const completed = transfer.status === "completed";

  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      <Text
        accessibilityRole="text"
        numberOfLines={2}
        className="min-w-0 flex-1 font-sans text-sm text-foreground"
      >
        {completed
          ? `Transferred to ${destinationLabel}`
          : "Transfer to another environment did not finish"}
      </Text>
      {completed ? (
        destination !== undefined && destinationConfig !== undefined ? (
          <RequestActionButton
            label="Open"
            tone="secondary"
            onPress={() => openThread(destination)}
          />
        ) : null
      ) : (
        <>
          <RequestActionButton
            label="Unlock"
            tone="secondary"
            onPress={() =>
              void unlockTransferredThread({ source: threadRef, transferId: transfer.transferId })
            }
          />
          <RequestActionButton
            label="Finish"
            onPress={() =>
              void transferThreadFromMobile({
                source: threadRef,
                transferId: transfer.transferId,
                openThread,
              })
            }
          />
        </>
      )}
    </View>
  );
}
