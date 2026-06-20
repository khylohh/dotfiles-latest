import type { LiveSFXProject, SFXCategory, SFXEvent, SFXFile } from '../src/lib/types';

export function clamp(value: number, min: number, max: number): number;
export function dbToLinear(db: number): number;
export function eventEndSeconds(startSeconds: number, duration: number): number;
export function eventAudibleStart(event: SFXEvent): number;
export function buildSFXEvent(options: {
  category: SFXCategory;
  file: SFXFile;
  project: LiveSFXProject;
  playbackRate: number;
  startSeconds?: number;
  audibleStartSeconds?: number;
  id?: string;
  createdAt?: string;
  snapZoomId?: string;
}): SFXEvent;
export function packEvents(events: SFXEvent[]): SFXEvent[];
export function packNewEventsAroundFixedEvents(fixedEvents: SFXEvent[], newEvents: SFXEvent[], fps?: number): SFXEvent[];
