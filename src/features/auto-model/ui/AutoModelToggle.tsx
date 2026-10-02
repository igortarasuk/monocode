import { useSyncExternalStore } from "react";
import { LoaderCircle, WandSparkles } from "../../../shared/ui/icons";
import {
  autoModelActivity,
  autoModelPick,
  autoModelRevision,
  isAutoModel,
  setAutoModel,
  subscribeAutoModel,
  type AutoModelActivity,
} from "../model/autoModelStore";

const ACTIVITY_LABEL: Record<AutoModelActivity, string> = {
  routing: "Choosing model…",
  reviewing: "Checking task…",
  moving: "New session…",
};

/**
 * Composer switch for Auto model. On: a small model sizes up the first
 * message and picks the model; picking a model by hand turns it off.
 */
export function AutoModelToggle({ sessionId }: { sessionId: string }) {
  useSyncExternalStore(subscribeAutoModel, autoModelRevision, autoModelRevision);
  const auto = isAutoModel(sessionId);
  const activity = autoModelActivity(sessionId);
  const pick = autoModelPick(sessionId);
  const title = !auto
    ? "Auto model is off: this session keeps the model you picked. Click to let Monochrome choose the model for each task."
    : pick
      ? `Auto picked ${pick.model}${pick.effort ? ` (${pick.effort})` : ""} for a ${pick.scale} ${pick.kind} task${pick.reason ? `: ${pick.reason}` : "."}`
      : "Auto model is on: the model is chosen from your first message. A different task in a long session continues in a new one.";

  return (
    <button
      type="button"
      data-auto-model-toggle
      title={title}
      aria-label="Auto model"
      aria-pressed={auto}
      disabled={!!activity}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setAutoModel(sessionId, !auto)}
      className={`flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] ${
        auto
          ? "bg-selection text-content hover:bg-selection-hover"
          : "text-content/45 hover:bg-selection hover:text-content"
      }`}
    >
      {activity ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <WandSparkles className="size-3.5 shrink-0" />
      )}
      <span className="whitespace-nowrap">
        {activity ? ACTIVITY_LABEL[activity] : "Auto"}
      </span>
    </button>
  );
}
