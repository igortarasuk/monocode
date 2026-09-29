import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

const POLL_MS = 60_000;

export type ServicesStatusData = {
  teleport: { cluster: string | null; validUntil: string | null } | null;
  docker: {
    running: boolean;
    containers: number;
    version: string | null;
  } | null;
  vagrant: { running: string[] } | null;
};

type Chip = {
  key: string;
  label: string;
  tone: "ok" | "off" | "warn";
  title: string;
};

/** Chips for installed services only; nothing renders when none is installed. */
export function serviceChips(
  status: ServicesStatusData,
  now = Date.now(),
): Chip[] {
  const chips: Chip[] = [];
  if (status.teleport) {
    const until = status.teleport.validUntil
      ? Date.parse(status.teleport.validUntil)
      : NaN;
    const cluster = status.teleport.cluster;
    const valid = Boolean(cluster) && Number.isFinite(until) && until > now;
    chips.push({
      key: "teleport",
      label: valid ? cluster!.split(".")[0] : "Teleport",
      tone: valid ? "ok" : cluster ? "warn" : "off",
      title: valid
        ? `Teleport: ${cluster}, valid until ${new Date(until).toLocaleString()}`
        : cluster
          ? `Teleport: certificate for ${cluster} expired. Run tsh login.`
          : "Teleport: not logged in. Run tsh login.",
    });
  }
  if (status.docker) {
    const { running, containers, version } = status.docker;
    chips.push({
      key: "docker",
      label: running ? `Docker ${containers}` : "Docker",
      tone: running ? "ok" : "off",
      title: running
        ? `Docker ${version ?? ""}: ${containers} running container${containers === 1 ? "" : "s"}`
        : "Docker daemon is not running",
    });
  }
  if (status.vagrant && status.vagrant.running.length) {
    const names = status.vagrant.running;
    chips.push({
      key: "vagrant",
      label: `Vagrant ${names.length}`,
      tone: "ok",
      title: `Vagrant running: ${names.join(", ")}`,
    });
  }
  return chips;
}

function useServicesStatus(): ServicesStatusData | null {
  const [status, setStatus] = useState<ServicesStatusData | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      try {
        const next = await invoke<ServicesStatusData>("services_status");
        if (live) setStatus(next);
      } catch {
        // The footer keeps the last known state.
      }
      if (live) timer = setTimeout(() => void load(), POLL_MS);
    };
    const onFocus = () => void load();
    void load();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return status;
}

const DOT: Record<Chip["tone"], string> = {
  ok: "bg-emerald-400",
  off: "bg-content/25",
  warn: "bg-amber-400",
};

export function ServicesStatus() {
  const status = useServicesStatus();
  if (!status) return null;
  const chips = serviceChips(status);
  if (!chips.length) return null;
  return (
    <div
      role="group"
      aria-label="Local services"
      className="flex shrink-0 items-center gap-2.5 pl-1"
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.title}
          aria-label={chip.title}
          className="inline-flex items-center gap-1 whitespace-nowrap"
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${DOT[chip.tone]}`}
          />
          {chip.label}
        </span>
      ))}
    </div>
  );
}
