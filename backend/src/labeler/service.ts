/**
 * The Spooktober labeler: labels the profile changes of accounts that opted
 * in (by liking or following the labeler) during October.
 */

import { EventEmitter } from "node:events";
import type { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import type { ProfileChange } from "../../../shared/types.js";
import { createLabel, signLabel } from "./labels.js";
import {
  labelsForChange,
  LABEL_VALUES,
  seasonOf,
  type LabelValue,
} from "./policy.js";
import type { LabelEvent } from "./store.js";

export interface LabelerDeps {
  // DID of the labeler account (`src` of every label)
  did: string;
  key: Secp256k1PrivateKeyExportable;
  insertLabel: (
    label: Awaited<ReturnType<typeof signLabel>>,
  ) => Promise<LabelEvent>;
  queryActiveLabels: (options: {
    uriPatterns: readonly string[];
    limit: number;
  }) => Promise<{ events: LabelEvent[] }>;
  isOptedIn: (did: string) => Promise<boolean>;
  // Changes of an account since a point in time (for retroactive labels)
  getChangesSince: (did: string, since: Date) => Promise<ProfileChange[]>;
  now?: () => Date;
}

/**
 * Create the labeler.
 *
 * @param deps Identity, signing key and storage operations.
 * @returns Operations to label changes and react to opt-ins/opt-outs, plus
 *   an event emitter for live subscribers ("label" events).
 */
export function createLabeler(deps: LabelerDeps) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const now = deps.now ?? (() => new Date());

  // Values currently applied to an account
  async function activeValues(did: string): Promise<Set<string>> {
    const { events: active } = await deps.queryActiveLabels({
      uriPatterns: [did],
      limit: LABEL_VALUES.length + 10,
    });
    return new Set(active.map((e) => e.label.val));
  }

  async function emit(input: {
    uri: string;
    val: string;
    neg?: boolean;
    exp?: Date;
  }): Promise<LabelEvent> {
    const label = await signLabel(
      createLabel({ src: deps.did, cts: now(), ...input }),
      deps.key,
    );
    const event = await deps.insertLabel(label);
    events.emit("label", event);
    return event;
  }

  // Apply values to an account unless they are already active
  async function apply(did: string, values: LabelValue[], exp: Date) {
    const active = await activeValues(did);
    const emitted: LabelEvent[] = [];
    for (const val of new Set(values)) {
      if (!active.has(val)) emitted.push(await emit({ uri: did, val, exp }));
    }
    return emitted;
  }

  /**
   * Label a recorded change, if its account opted in and it is October.
   */
  async function onChange(change: ProfileChange): Promise<LabelEvent[]> {
    const season = seasonOf(new Date(change.changed_at));
    if (!season || !(await deps.isOptedIn(change.did))) return [];
    return apply(change.did, labelsForChange(change), season.end);
  }

  /**
   * An account opted in: label its changes from this season so far.
   */
  async function onOptIn(did: string): Promise<LabelEvent[]> {
    const season = seasonOf(now());
    if (!season) return [];
    const changes = await deps.getChangesSince(did, season.start);
    return apply(did, changes.flatMap(labelsForChange), season.end);
  }

  /**
   * An account withdrew its opt-in: retract all its active labels.
   */
  async function onOptOut(did: string): Promise<LabelEvent[]> {
    const emitted: LabelEvent[] = [];
    for (const val of await activeValues(did)) {
      emitted.push(await emit({ uri: did, val, neg: true }));
    }
    return emitted;
  }

  return { did: deps.did, events, onChange, onOptIn, onOptOut };
}

export type Labeler = ReturnType<typeof createLabeler>;
