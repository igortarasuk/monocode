import { X } from "../../../shared/ui/icons";
import type { LinearLabelOption } from "../model/sprint";

type Props = {
  options: readonly LinearLabelOption[];
  value: readonly string[];
  onChange: (labelIds: string[]) => void;
  /** Shown instead of chips when nothing is chosen. */
  placeholder?: string;
  ariaLabel?: string;
};

function labelColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

/** Chips for chosen labels plus a select that adds one more. */
export function LabelPicker({
  options,
  value,
  onChange,
  placeholder = "no label",
  ariaLabel = "Labels",
}: Props) {
  const chosen = value
    .map((id) => options.find((option) => option.id === id))
    .filter((option): option is LinearLabelOption => !!option);
  const unknown = value.filter((id) => !options.some((option) => option.id === id));
  const remaining = options.filter((option) => !value.includes(option.id));
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {chosen.map((option) => {
        const color = labelColor(option.color);
        return (
          <span
            key={option.id}
            className="inline-flex max-w-32 items-center gap-1 rounded bg-content/8 px-1.5 py-px text-[10px] text-content/70"
          >
            {color ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
            ) : null}
            <span className="truncate">{option.name}</span>
            <button
              type="button"
              aria-label={`Remove label ${option.name}`}
              onClick={() => onChange(value.filter((id) => id !== option.id))}
              className="grid size-3.5 place-items-center rounded text-content/40 hover:bg-content/15 hover:text-content"
            >
              <X className="size-2.5" strokeWidth={2} />
            </button>
          </span>
        );
      })}
      {unknown.length ? (
        <span className="text-[10px] text-content/40">+{unknown.length} unknown</span>
      ) : null}
      {chosen.length === 0 && unknown.length === 0 ? (
        <span className="text-[10px] text-amber-400">{placeholder}</span>
      ) : null}
      {remaining.length ? (
        <select
          aria-label={ariaLabel}
          value=""
          onChange={(event) => {
            if (event.target.value) onChange([...value, event.target.value]);
          }}
          className="h-5 max-w-28 rounded border border-content/10 bg-content/[0.03] px-1 text-[10px] text-content/60 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <option value="">+ label</option>
          {remaining.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}
