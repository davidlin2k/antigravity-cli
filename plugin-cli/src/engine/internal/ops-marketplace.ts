import fs from "node:fs/promises";
import { deriveMarketplaceId } from "../../domain/query.ts";
import { makeIsoTimestamp } from "../../domain/types.ts";
import type { EngineError, EngineResult } from "../../domain/types.ts";
import type {
  AddMarketplaceInput,
  BulkSyncReport,
  MarketplaceSyncOutcome,
  MarketplaceSyncReport,
  RemoveMarketplaceInput,
  RemoveMarketplaceReport,
  SyncMarketplacesInput,
} from "../contract.ts";
import type { EngineRuntime } from "./engine-context.ts";
import { resolveMarketplaceSource, syncSingleMarketplace } from "./fetcher.ts";
import { withTargetLock } from "./fs-safety.ts";
import {
  deleteSyncCache,
  loadKnownMarketplaces,
  marketplaceMirrorPath,
  registryLockPath,
  saveKnownMarketplaces,
} from "./stores.ts";
import type { KnownMarketplaceEntry } from "./stores.ts";

type MarketplaceRegistrationResult =
  | { readonly ok: true; readonly entry: KnownMarketplaceEntry }
  | { readonly ok: false; readonly error: EngineError };

export async function opAddMarketplace(
  ctx: EngineRuntime,
  input: AddMarketplaceInput,
): Promise<EngineResult<MarketplaceSyncReport>> {
  const { paths, timeoutMs } = ctx;
  const id = input.id ?? deriveMarketplaceId(input.source);

  try {
    const registration = await withTargetLock<MarketplaceRegistrationResult>(
      registryLockPath(paths),
      async () => {
        const existing = await loadKnownMarketplaces(paths);
        if (existing.some((entry) => entry.id === id)) {
          return { ok: false, error: { kind: "marketplace-exists", id } };
        }

        const resolved = await resolveMarketplaceSource(input.source, timeoutMs);
        if (!resolved.ok) {
          return {
            ok: false,
            error: {
              kind: "marketplace-sync-failed",
              id,
              reason: resolved.reason,
            },
          };
        }

        const entry: KnownMarketplaceEntry = {
          id,
          source: resolved.source,
          addedAt: makeIsoTimestamp(),
        };
        await saveKnownMarketplaces(paths, [...existing, entry]);
        return { ok: true, entry };
      },
    );

    if (!registration.ok) {
      return ctx.fail(registration.error);
    }

    const outcome = await syncSingleMarketplace(paths, registration.entry, timeoutMs);
    const after = await ctx.commitMutation();
    if (outcome.status === "failed") {
      return {
        ok: false,
        error: {
          kind: "marketplace-sync-failed",
          id,
          reason: outcome.reason ?? "Marketplace sync failed.",
        },
        snapshot: after,
      };
    }
    return {
      ok: true,
      report: { outcome },
      snapshot: after,
    };
  } catch (err) {
    return ctx.mapLockOrIoError(err, "add-marketplace");
  }
}

export async function opSyncMarketplaces(
  ctx: EngineRuntime,
  input: SyncMarketplacesInput,
): Promise<EngineResult<BulkSyncReport>> {
  const { paths, timeoutMs } = ctx;
  const known = await loadKnownMarketplaces(paths);

  if (input.kind === "single") {
    const entry = known.find((m) => m.id === input.id);
    if (entry === undefined) {
      return ctx.fail({ kind: "marketplace-not-found", id: input.id });
    }
    const outcome = await syncSingleMarketplace(paths, entry, timeoutMs);
    const after = await ctx.commitMutation();
    if (outcome.status === "failed") {
      return {
        ok: false,
        error: {
          kind: "marketplace-sync-failed",
          id: entry.id,
          reason: outcome.reason ?? "Marketplace sync failed.",
        },
        snapshot: after,
      };
    }
    return {
      ok: true,
      report: { outcomes: [outcome] },
      snapshot: after,
    };
  }

  const outcomes: MarketplaceSyncOutcome[] = await Promise.all(
    known.map((entry) => syncSingleMarketplace(paths, entry, timeoutMs)),
  );
  const after = await ctx.commitMutation();
  return {
    ok: true,
    report: { outcomes },
    snapshot: after,
  };
}

export async function opRemoveMarketplace(
  ctx: EngineRuntime,
  input: RemoveMarketplaceInput,
): Promise<EngineResult<RemoveMarketplaceReport>> {
  const { paths } = ctx;
  try {
    const removed = await withTargetLock<{ readonly ok: boolean }>(
      registryLockPath(paths),
      async () => {
        const existing = await loadKnownMarketplaces(paths);
        const found = existing.find((m) => m.id === input.id);
        if (found === undefined) {
          return { ok: false };
        }
        const next = existing.filter((m) => m.id !== input.id);
        await saveKnownMarketplaces(paths, next);
        return { ok: true };
      },
    );

    if (!removed.ok) {
      return ctx.fail({ kind: "marketplace-not-found", id: input.id });
    }

    await deleteSyncCache(paths, input.id);

    const mirrorDir = marketplaceMirrorPath(paths, input.id);
    const mirrorExists = await fs
      .lstat(mirrorDir)
      .then(() => true)
      .catch(() => false);
    if (mirrorExists) {
      await fs.rm(mirrorDir, { recursive: true, force: true });
    }

    const after = await ctx.commitMutation();
    return {
      ok: true,
      report: {
        id: input.id,
        removedMirror: mirrorExists,
      },
      snapshot: after,
    };
  } catch (err) {
    return ctx.mapLockOrIoError(err, "remove-marketplace");
  }
}
