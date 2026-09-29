import { useEffect, useState, useSyncExternalStore } from "react";
import { isHarnessAvailable } from "../../../integrations/harness/core/availability";
import { TEXT_HARNESSES } from "../../../integrations/harness/core/textHarness";
import { describeTextGenerator } from "../../../integrations/harness/core/textGenerator";
import {
  getModelSnapshot,
  modelsFor,
  subscribeModels,
} from "../../sessions/model/models";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import {
  providerAccounts,
  supportsProviderAccounts,
} from "../model/providerAccounts";
import {
  loadTextGeneratorSettings,
  saveTextGeneratorSettings,
  subscribeTextGeneratorSettings,
  type TextGeneratorSettings,
} from "../model/textGeneratorSettings";

const SELECT =
  "h-7 max-w-56 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content outline-none focus:border-content/20";

/**
 * Settings row: which provider, model and account write commit messages and
 * PR text. Lists come from the live catalogs; blank means automatic.
 */
export function TextGeneratorSettingsCard({ cwd }: { cwd: string }) {
  const [settings, setSettings] = useState<TextGeneratorSettings>(
    loadTextGeneratorSettings,
  );
  useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  useEffect(
    () =>
      subscribeTextGeneratorSettings(() =>
        setSettings(loadTextGeneratorSettings()),
      ),
    [],
  );

  const update = (next: TextGeneratorSettings) => {
    setSettings(next);
    saveTextGeneratorSettings(next);
  };

  const harness = settings.harness;
  const harnesses = TEXT_HARNESSES.filter(
    (id) => id === harness || isHarnessAvailable(id),
  );
  const models = harness ? modelsFor(harness) : [];
  const accounts =
    harness && supportsProviderAccounts(harness)
      ? providerAccounts(harness)
      : [];

  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Text provider"
          className={SELECT}
          value={harness ?? ""}
          onChange={(event) =>
            update(
              event.target.value
                ? { harness: event.target.value as HarnessId }
                : {},
            )
          }
        >
          <option value="">Auto (active session's provider)</option>
          {harnesses.map((id) => (
            <option key={id} value={id}>
              {HARNESS_TITLE[id]}
            </option>
          ))}
        </select>
        {harness ? (
          <select
            aria-label="Text model"
            className={SELECT}
            value={settings.model ?? ""}
            onChange={(event) =>
              update({ ...settings, model: event.target.value || undefined })
            }
          >
            <option value="">Provider default</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.provider ? `${model.provider.name} · ` : ""}
                {model.name}
              </option>
            ))}
          </select>
        ) : null}
        {accounts.length > 1 ? (
          <select
            aria-label="Text account"
            className={SELECT}
            value={settings.accountId ?? ""}
            onChange={(event) =>
              update({
                ...settings,
                accountId: event.target.value || undefined,
              })
            }
          >
            <option value="">Project's account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <p className="text-content/45">Now: {describeTextGenerator(cwd)}</p>
    </div>
  );
}
