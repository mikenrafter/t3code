import type { OrchestrationUsageGuard } from "@t3tools/contracts";
import { formatDuration, formatResetsIn } from "@t3tools/shared/usageLimits";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

/**
 * The usage guard's persisted prompt or pause, docked above the composer. The
 * answers mirror the web banner: compact (pauses the thread), keep going
 * (suppresses the prompts until the window resets), or wait (local dismiss).
 * "Compact & continue" is web-only for now — on mobile, /compact in the
 * composer is the way to compact without pausing.
 */
export function ComposerUsageGuard({
  guard,
  onCompact,
  onKeepGoing,
  onResume,
  onDismiss,
}: {
  readonly guard: OrchestrationUsageGuard;
  readonly onCompact: () => void;
  readonly onKeepGoing: () => void;
  readonly onResume: () => void;
  readonly onDismiss: () => void;
}) {
  const now = Date.now();
  if (guard.phase === "paused") {
    const resumable = guard.scheduledAt !== null && guard.scheduledAt !== undefined;
    const resumeIn =
      guard.resumeAt === null || guard.resumeAt === undefined
        ? null
        : formatDuration(Date.parse(guard.resumeAt) - now);
    return (
      <View className="px-4 pb-3">
        <View className="gap-2 rounded-[20px] border-continuous bg-card p-4">
          <View className="flex-row items-center gap-3">
            <Text
              accessibilityLiveRegion="polite"
              className="min-w-0 flex-1 text-sm text-foreground"
            >
              {guard.reason === "provider_error"
                ? "Paused — the provider hit its usage limit"
                : "Paused — usage window nearly exhausted"}
            </Text>
          </View>
          <Text selectable className="text-xs text-foreground-muted">
            {resumable
              ? `The thread will resume${resumeIn === null ? "" : ` in ${resumeIn}`}, and the agent decides whether the work is still relevant.`
              : "The thread stays paused until you resume it."}
          </Text>
          {resumable ? <ActionRow actions={[{ label: "Resume now", onPress: onResume }]} /> : null}
        </View>
      </View>
    );
  }
  const resetsIn =
    guard.windowResetsAt === null || guard.windowResetsAt === undefined
      ? null
      : formatResetsIn(
          {
            id: guard.windowId,
            kind: guard.windowKind,
            label: "",
            usedPercent: guard.usedPercent,
            resetsAt: guard.windowResetsAt,
          },
          now,
        );
  return (
    <View className="px-4 pb-3">
      <View className="gap-2 rounded-[20px] border-continuous bg-card p-4">
        <View className="flex-row items-center gap-3">
          <Text accessibilityLiveRegion="polite" className="min-w-0 flex-1 text-sm text-foreground">
            {`Usage window at ${guard.usedPercent}%`}
          </Text>
          <Pressable
            accessibilityLabel="Wait for the window to reset"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onDismiss}
            className="-me-1 p-1 active:opacity-60"
          >
            <SymbolView
              name="xmark"
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
        <Text selectable className="text-xs text-foreground-muted">
          {`Consider waiting for the window to reset${resetsIn === null ? "" : ` (${resetsIn})`} or compacting now.`}
        </Text>
        <ActionRow
          actions={[
            { label: "Compact", onPress: onCompact },
            { label: "Keep going", onPress: onKeepGoing },
          ]}
        />
      </View>
    </View>
  );
}

function ActionRow({
  actions,
}: {
  readonly actions: ReadonlyArray<{ readonly label: string; readonly onPress: () => void }>;
}) {
  return (
    <View className="flex-row flex-wrap gap-4">
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          onPress={action.onPress}
          className="self-start py-1 active:opacity-60"
        >
          <Text className="text-sm text-foreground">{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
