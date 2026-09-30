// Site-owned copy of src/protocol/header.ts eventHeader.
import type { Event, EventHeader } from './schemas.js';

export function eventHeader(ev: Pick<Event, 'v' | 'team' | 'id' | 'origin' | 'seq' | 'ts' | 'kind' | 'channel'>): EventHeader {
  return {
    v: ev.v, team: ev.team, id: ev.id, origin: ev.origin, seq: ev.seq, ts: ev.ts, kind: ev.kind,
    ...(ev.channel !== undefined ? { channel: ev.channel } : {}),
  };
}
