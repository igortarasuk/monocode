import { useEffect, useMemo, useState } from "react";
import {
  filterNodes,
  nodeDisplayName,
  profileExpired,
  teleportNodes,
  teleportStatus,
  type TeleportNode,
  type TeleportProfile,
  type TeleportRoute,
} from "../model/teleport";

const MAX_SHOWN = 200;

/**
 * Pick a node from a logged-in Teleport cluster. Renders nothing when `tsh`
 * is missing or has no profiles, so plain SSH stays the default.
 */
export function TeleportPicker({
  disabled,
  selected,
  onPick,
  onClear,
}: {
  disabled: boolean;
  selected: TeleportRoute | null;
  onPick: (pick: {
    route: TeleportRoute;
    target: string;
    name: string;
  }) => void;
  onClear: () => void;
}) {
  const [profiles, setProfiles] = useState<TeleportProfile[] | null>(null);
  const [cluster, setCluster] = useState("");
  const [login, setLogin] = useState("");
  const [nodes, setNodes] = useState<TeleportNode[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    teleportStatus()
      .then((status) => {
        if (!live) return;
        const list = status.installed ? status.profiles : [];
        setProfiles(list);
        const first =
          list.find((profile) => !profileExpired(profile)) ?? list[0];
        if (first) setCluster(first.cluster);
      })
      .catch(() => live && setProfiles([]));
    return () => {
      live = false;
    };
  }, []);

  const profile = profiles?.find((item) => item.cluster === cluster);
  const expired = profile ? profileExpired(profile) : false;

  useEffect(() => {
    setLogin(profile?.logins[0] ?? "");
    setNodes(null);
    setError("");
    if (!profile || expired) return;
    let live = true;
    teleportNodes({ proxy: profile.proxy, cluster: profile.cluster })
      .then((list) => live && setNodes(list))
      .catch((reason) => {
        if (!live) return;
        setNodes([]);
        setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [profile, expired]);

  const shown = useMemo(
    () => filterNodes(nodes ?? [], query).slice(0, MAX_SHOWN),
    [nodes, query],
  );

  if (!profiles?.length) return null;

  const pick = (node: TeleportNode) => {
    if (!profile || !login) return;
    onPick({
      route: { proxy: profile.proxy, cluster: profile.cluster },
      target: `${login}@${node.hostname}`,
      name: nodeDisplayName(node),
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-content/10 p-3 text-[12px] text-content/65">
      <div className="flex items-center justify-between">
        <span className="font-medium text-content/80">Teleport</span>
        {selected ? (
          <button
            type="button"
            disabled={disabled}
            className="text-content/50 hover:text-content"
            onClick={onClear}
          >
            Use plain SSH
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Teleport cluster"
          disabled={disabled}
          value={cluster}
          onChange={(event) => setCluster(event.target.value)}
          className="rounded-md border border-content/12 bg-transparent px-2 py-1"
        >
          {profiles.map((item) => (
            <option key={item.cluster} value={item.cluster}>
              {item.cluster}
              {profileExpired(item) ? " (expired)" : ""}
            </option>
          ))}
        </select>
        <select
          aria-label="Teleport login"
          disabled={disabled || !profile?.logins.length}
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          className="rounded-md border border-content/12 bg-transparent px-2 py-1"
        >
          {(profile?.logins ?? []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter Teleport nodes"
          disabled={disabled || expired}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by host or label"
          spellCheck={false}
          className="min-w-40 flex-1 rounded-md border border-content/12 bg-transparent px-2 py-1 outline-none"
        />
      </div>
      {expired ? (
        <p>
          The certificate for {cluster} has expired. Run{" "}
          <code className="rounded bg-content/10 px-1">
            tsh login --proxy={profile?.proxy}
          </code>{" "}
          and reopen this form.
        </p>
      ) : error ? (
        <p className="text-red-400/90">{error}</p>
      ) : nodes === null ? (
        <p>Loading nodes…</p>
      ) : (
        <ul
          aria-label="Teleport nodes"
          className="max-h-48 divide-y divide-content/7 overflow-y-auto rounded-md border border-content/10"
        >
          {shown.map((node) => (
            <li key={node.id || node.hostname}>
              <button
                type="button"
                disabled={disabled || !login}
                onClick={() => pick(node)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-content/6"
              >
                <span className="font-medium text-content/85">
                  {nodeDisplayName(node)}
                </span>
                <span className="min-w-0 flex-1 truncate text-content/45">
                  {node.hostname}
                </span>
              </button>
            </li>
          ))}
          {!shown.length ? <li className="px-2.5 py-1.5">No nodes.</li> : null}
        </ul>
      )}
    </div>
  );
}
