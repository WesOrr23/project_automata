/**
 * SimulationControls Component
 *
 * Fixed-layout controls with character progress display.
 * Layout order: speed config → play → back/step → character progress → result.
 */

import { useEffect, useRef } from 'react';
import { SimulationStatus } from '../hooks/useSimulation';
import { SIMULATION_SPEED_MIN, SIMULATION_SPEED_MAX } from '../ui-state/constants';

type SimulationControlsProp = {
  status: SimulationStatus;
  hasSimulation: boolean;
  accepted: boolean | null;
  speed: number;
  input: string;
  consumedCount: number;
  onStep: () => void;
  onPlay: () => void;
  onPause: () => void;
  onStepBack: () => void;
  canStepBack: boolean;
  onSpeedChange: (speed: number) => void;
  onJumpTo: (characterIndex: number) => void;
  /** Incrementing counter; when it changes the Play button gets
   *  focused. Used by the batch-test "load this input" affordance —
   *  after the modal injects the input string and closes, focus
   *  lands on Play so a click or Space/Enter starts the simulation. */
  playFocusSignal?: number;
};

const SPEED_PRESETS = {
  slow: SIMULATION_SPEED_MAX,
  fast: SIMULATION_SPEED_MIN,
} as const;

type SpeedPreset = keyof typeof SPEED_PRESETS;

function closestPreset(speedMs: number): SpeedPreset {
  const midpoint = (SIMULATION_SPEED_MIN + SIMULATION_SPEED_MAX) / 2;
  return speedMs > midpoint ? 'slow' : 'fast';
}

export function SimulationControls({
  status,
  hasSimulation,
  accepted,
  speed,
  input,
  consumedCount,
  onStep,
  onPlay,
  onPause,
  onStepBack,
  canStepBack,
  onSpeedChange,
  onJumpTo,
  playFocusSignal,
}: SimulationControlsProp) {
  const playButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (playFocusSignal === undefined) return;
    // Defer so focus lands after the calling code's render commits
    // (the input-string update propagates the same tick).
    const id = window.setTimeout(() => playButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [playFocusSignal]);
  // Step / Play remain available as long as the engine isn't actively
  // running. Empty input is a valid simulation (the empty string ε) —
  // pressing Play runs to completion and the result depends on whether
  // the start state is also an accept state (modulo ε-closure for NFAs).
  const canStep = status === 'idle' || status === 'paused';
  // Play allows replay from a finished state — re-initialises and runs.
  const canPlay = status === 'idle' || status === 'paused' || status === 'finished';
  const canPause = status === 'running';

  const activePreset = closestPreset(speed);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>

      {/* 1. Configuration — speed toggle */}
      <div>
        <span className="label" style={{ display: 'block', marginBottom: 'var(--space-2)' }}>
          Speed
        </span>
        <div className="speed-toggle">
          <button
            className={`speed-toggle-option ${activePreset === 'slow' ? 'active' : ''}`}
            onClick={() => onSpeedChange(SPEED_PRESETS.slow)}
          >
            Slow
          </button>
          <button
            className={`speed-toggle-option ${activePreset === 'fast' ? 'active' : ''}`}
            onClick={() => onSpeedChange(SPEED_PRESETS.fast)}
          >
            Fast
          </button>
        </div>
      </div>

      {/* 2. Playback section — label, progress, then buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <span className="label">Playback</span>

        {/* Character progress display */}
        <div
          style={{
            fontSize: 'var(--text-mono)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '4px',
            lineHeight: 1,
            minHeight: 'var(--text-mono)',
            display: 'flex',
            flexWrap: 'wrap',
          }}
        >
          {input.length === 0 && (
            // Dim ε in the mono strip — communicates "the empty string is
            // a valid input to test" and is visually distinct from a
            // placeholder hint ("type something").
            <span style={{ color: 'var(--text-secondary)' }}>
              ε
            </span>
          )}
          {input.length > 0 && [...input].map((character, index) => {
            const isConsumed = hasSimulation && index < consumedCount;
            const isNext = hasSimulation && index === consumedCount;
            const isClickable = true;

            const baseColor = isConsumed
              ? 'var(--text-consumed)'
              : isNext
                ? 'var(--text-heading)'
                : 'var(--text-body)';

            return (
              <span
                key={index}
                onClick={isClickable ? () => onJumpTo(index) : undefined}
                style={{
                  color: baseColor,
                  fontWeight: isNext ? 'var(--weight-bold)' : 'var(--weight-normal)',
                  textDecoration: isNext ? 'underline' : 'none',
                  textUnderlineOffset: '4px',
                  textDecorationColor: isNext ? 'var(--blue-400)' : undefined,
                  cursor: isClickable ? 'pointer' : 'default',
                  transition: 'color 0.15s ease',
                }}
                onMouseEnter={(event) => {
                  if (isClickable) {
                    (event.target as HTMLSpanElement).style.color = 'var(--blue-500)';
                  }
                }}
                onMouseLeave={(event) => {
                  if (isClickable) {
                    (event.target as HTMLSpanElement).style.color = baseColor;
                  }
                }}
              >
                {character}
              </span>
            );
          })}
        </div>

        {/* Play/Pause */}
        {status === 'running' ? (
          <button className="btn" onClick={onPause} disabled={!canPause} style={{ width: '100%' }}>
            Pause
          </button>
        ) : (
          <button ref={playButtonRef} className="btn btn-primary" onClick={onPlay} disabled={!canPlay} style={{ width: '100%' }}>
            Play
          </button>
        )}

        {/* Back / Step */}
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="btn" onClick={onStepBack} disabled={!canStepBack} style={{ flex: 1 }}>
            Back
          </button>
          <button className="btn" onClick={onStep} disabled={!canStep} style={{ flex: 1 }}>
            Step
          </button>
        </div>
      </div>

      {/* 5. Result banner */}
      {status === 'finished' && accepted !== null && (
        <div className={`result-banner ${accepted ? 'accepted' : 'rejected'}`}>
          {accepted ? 'ACCEPTED' : 'REJECTED'}
        </div>
      )}
    </div>
  );
}
