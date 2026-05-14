/**
 * useSimulation Hook
 *
 * Manages DFA simulation state for the UI layer.
 * Wraps the engine's Simulation type with React state management,
 * status tracking, history for step-back, and an auto-step timer.
 *
 * Architecture:
 * - Pure reducer function (simulationReducer) handles all state transitions
 * - useEffect manages the auto-step timer when status is 'running'
 * - Derived values (currentStateIds, stepIndex, etc.) are computed each render
 * - History array stores every Simulation snapshot for backward navigation
 *
 * Status state machine:
 *   idle → step → idle (or finished)
 *   idle → run → running
 *   running → auto-step exhausts input → finished
 *   running → pause → paused
 *   paused → step → paused (or finished)
 *   paused → run → running
 *   paused → stepBack → paused (or idle if back to start)
 *   idle → stepBack → idle (if history exists)
 *   ANY → reset → idle
 *   ANY → initialize → idle
 */

import { useReducer, useEffect, useCallback, useRef } from 'react';
import { Automaton, Simulation } from '../engine/types';
import {
  createSimulation,
  step as engineStep,
  isFinished as engineIsFinished,
  isAccepted as engineIsAccepted,
} from '../engine/simulator';
import {
  SIMULATION_SPEED_MIN,
  SIMULATION_SPEED_MAX,
  SIMULATION_SPEED_DEFAULT,
} from '../ui-state/constants';
import { useNotifications } from '../notifications/useNotifications';

/**
 * Cap on the number of simulation snapshots retained in history.
 *
 * Each `step` / `autoStep` appends a new Simulation to `state.history`. Without
 * a cap, long inputs (e.g. a million-character string) grow memory linearly
 * with input length and re-clone the array each step (quadratic work). 1000
 * comfortably covers the educational use case (the longest pedagogically
 * meaningful inputs are dozens of symbols, not thousands), while bounding
 * worst-case memory.
 *
 * Behavior at the cap:
 * - `step` and `autoStep` refuse to advance further forward.
 * - The hook surfaces a notification so the user understands why stepping
 *   stopped and what to do (reset).
 * - `stepBack` still works — the user can navigate the existing history.
 * - `reset` clears history and the cap.
 */
export const SIMULATION_HISTORY_CAP = 1000;

// --- Types ---

export type SimulationStatus = 'idle' | 'running' | 'paused' | 'finished';

export type SimulationState = {
  /** History of simulation snapshots (index 0 = initial, last = current) */
  history: Simulation[];
  /** Current position in the history array */
  historyIndex: number;
  status: SimulationStatus;
  speed: number;
};

export type SimulationAction =
  | { type: 'initialize'; automaton: Automaton; input: string }
  | { type: 'step' }
  | { type: 'stepBack' }
  | { type: 'jumpTo'; index: number; automaton?: Automaton; input?: string }
  | { type: 'autoStep' }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'reset' }
  | { type: 'setSpeed'; speed: number };

// --- Reducer ---

export const initialState: SimulationState = {
  history: [],
  historyIndex: -1,
  status: 'idle',
  speed: SIMULATION_SPEED_DEFAULT,
};

/** Get the current simulation from state, or null if none. */
function currentSimulation(state: SimulationState): Simulation | null {
  if (state.historyIndex < 0 || state.history.length === 0) return null;
  return state.history[state.historyIndex]!;
}

/**
 * Pure reducer for simulation state transitions.
 * Exported for direct testing without React.
 */
export function simulationReducer(
  state: SimulationState,
  action: SimulationAction
): SimulationState {
  switch (action.type) {
    case 'initialize': {
      // createSimulation returns Result. A failure here means the
      // automaton isn't runnable (incomplete DFA, no start state, etc.) —
      // the UI gates initialization on isRunnable already, so reaching
      // this branch means a stale snapshot. Stay idle with empty history.
      const result = createSimulation(action.automaton, action.input);
      if (!result.ok) {
        return { ...state, history: [], historyIndex: -1, status: 'idle' };
      }
      const simulation = result.value;
      const status = engineIsFinished(simulation) ? 'finished' : 'idle';
      return { ...state, history: [simulation], historyIndex: 0, status };
    }

    case 'step': {
      const simulation = currentSimulation(state);
      if (simulation === null) return state;
      if (state.status === 'finished' || state.status === 'running') return state;

      // History cap: refuse to advance once we've recorded
      // SIMULATION_HISTORY_CAP snapshots. The dispatcher boundary (in the
      // hook) surfaces a notification on the first refusal — the reducer
      // itself stays pure.
      if (state.history.length >= SIMULATION_HISTORY_CAP) return state;

      // engineStep returns err on a DFA dead-end (e.g. an incomplete DFA
      // surviving past the runnable gate). The creator gating
      // (isRunnable) makes that unreachable through the UI today, but a
      // stale snapshot shouldn't crash the React tree — finish the
      // simulation in place so the user can reset.
      const stepResult = engineStep(simulation);
      if (!stepResult.ok) {
        return { ...state, status: 'finished' };
      }
      const newSimulation = stepResult.value;
      const isNowFinished = engineIsFinished(newSimulation);

      // Truncate any forward history (if we stepped back then step forward again)
      const newHistory = [...state.history.slice(0, state.historyIndex + 1), newSimulation];

      return {
        ...state,
        history: newHistory,
        historyIndex: newHistory.length - 1,
        status: isNowFinished ? 'finished' : state.status,
      };
    }

    case 'stepBack': {
      if (state.historyIndex <= 0) return state;
      if (state.status === 'running') return state;

      const newIndex = state.historyIndex - 1;
      const newStatus = state.status === 'finished' ? 'idle' : state.status;

      return {
        ...state,
        historyIndex: newIndex,
        status: newStatus,
      };
    }

    case 'jumpTo': {
      if (state.status === 'running') return state;
      if (action.index < 0) return state;

      // Auto-initialize if no simulation exists (or finished) and automaton/input provided
      let workingState = state;
      if ((currentSimulation(state) === null || state.status === 'finished')
          && action.automaton && action.input) {
        const result = createSimulation(action.automaton, action.input);
        if (!result.ok) {
          // Same fall-through as the 'initialize' case: structural
          // failure means the automaton isn't runnable, stay idle.
          return state;
        }
        workingState = { ...state, history: [result.value], historyIndex: 0, status: 'idle' };
      }

      const simulation = currentSimulation(workingState);
      if (simulation === null) return state;

      // Backward jump — index exists in history
      if (action.index < workingState.history.length) {
        const targetSimulation = workingState.history[action.index]!;
        const isNowFinished = engineIsFinished(targetSimulation);

        return {
          ...workingState,
          historyIndex: action.index,
          status: isNowFinished ? 'finished' : 'idle',
        };
      }

      // Forward jump — step forward from current history end to reach target.
      // engineStep returns Result; if it errs (e.g. DFA dead-end on a
      // stale automaton) we stop advancing and surface what we got so
      // far rather than crashing the reducer.
      let latestSimulation = workingState.history[workingState.history.length - 1]!;
      const newHistory = [...workingState.history];

      while (newHistory.length - 1 < action.index && !engineIsFinished(latestSimulation)) {
        const stepResult = engineStep(latestSimulation);
        if (!stepResult.ok) break;
        latestSimulation = stepResult.value;
        newHistory.push(latestSimulation);
      }

      const targetIndex = Math.min(action.index, newHistory.length - 1);
      const targetSimulation = newHistory[targetIndex]!;
      const isNowFinished = engineIsFinished(targetSimulation);

      return {
        ...workingState,
        history: newHistory,
        historyIndex: targetIndex,
        status: isNowFinished ? 'finished' : 'idle',
      };
    }

    case 'autoStep': {
      const simulation = currentSimulation(state);
      if (simulation === null || state.status !== 'running') return state;

      // History cap: stop the auto-step loop by transitioning out of
      // 'running'. We move to 'paused' so the user can step back or
      // reset; the dispatcher surfaces a notification.
      if (state.history.length >= SIMULATION_HISTORY_CAP) {
        return { ...state, status: 'paused' };
      }

      // Same pattern as the 'step' case: a Result err here means a
      // structural problem; finish the simulation so the timer effect
      // tears down and the user can reset.
      const stepResult = engineStep(simulation);
      if (!stepResult.ok) {
        return { ...state, status: 'finished' };
      }
      const newSimulation = stepResult.value;
      const isNowFinished = engineIsFinished(newSimulation);

      const newHistory = [...state.history.slice(0, state.historyIndex + 1), newSimulation];

      return {
        ...state,
        history: newHistory,
        historyIndex: newHistory.length - 1,
        status: isNowFinished ? 'finished' : 'running',
      };
    }

    case 'run': {
      const simulation = currentSimulation(state);
      if (simulation === null) return state;
      if (state.status === 'finished') return state;

      return { ...state, status: 'running' };
    }

    case 'pause': {
      if (state.status !== 'running') return state;

      return { ...state, status: 'paused' };
    }

    case 'reset': {
      return { ...state, history: [], historyIndex: -1, status: 'idle' };
    }

    case 'setSpeed': {
      const clampedSpeed = Math.max(SIMULATION_SPEED_MIN, Math.min(SIMULATION_SPEED_MAX, action.speed));
      return { ...state, speed: clampedSpeed };
    }
  }
}

// --- Hook ---

export function useSimulation(automaton: Automaton) {
  const [state, dispatch] = useReducer(simulationReducer, initialState);
  const { notify } = useNotifications();

  const simulation = currentSimulation(state);

  // Suppress duplicate cap notifications. We only want to inform the user
  // once per "session at the cap" — re-arm only after history shrinks
  // (reset, or step-back below the cap).
  const capNotifiedRef = useRef(false);
  useEffect(() => {
    if (state.history.length < SIMULATION_HISTORY_CAP) {
      capNotifiedRef.current = false;
    }
  }, [state.history.length]);

  const notifyCapReached = useCallback(() => {
    if (capNotifiedRef.current) return;
    capNotifiedRef.current = true;
    notify({
      severity: 'warning',
      title: `Simulation step limit reached (${SIMULATION_HISTORY_CAP}). Reset to continue.`,
    });
  }, [notify]);

  // Auto-step timer: schedules the next step when status is 'running'.
  // When we hit the cap mid-run, the reducer flips status to 'paused' on
  // the next autoStep dispatch — that re-renders this effect with a non-
  // 'running' status and clears the timer. We also surface the cap
  // notification here so the user sees why playback stopped.
  useEffect(() => {
    if (state.status !== 'running' || simulation === null) return;

    if (state.history.length >= SIMULATION_HISTORY_CAP) {
      notifyCapReached();
      return;
    }

    const timerId = setTimeout(() => {
      dispatch({ type: 'autoStep' });
    }, state.speed);

    return () => clearTimeout(timerId);
  }, [state.status, simulation, state.speed, state.history.length, notifyCapReached]);

  // Derived values
  const currentStateIds: Set<number> = simulation?.currentStates ?? new Set();
  const stepIndex: number = state.historyIndex;
  const consumedCount: number = simulation
    ? simulation.input.length - simulation.remainingInput.length
    : 0;
  const accepted: boolean | null =
    state.status === 'finished' && simulation
      ? engineIsAccepted(simulation)
      : null;

  // Dying state IDs from the most recent step — drives the branch-death
  // pulse. Only populated immediately after a step that killed branches;
  // step-back returns to a previous step (which may or may not have its
  // own dying set from when it originally happened).
  const dyingStateIds: ReadonlySet<number> =
    simulation?.steps[simulation.steps.length - 1]?.dyingStateIds ?? new Set();

  // Edges that just fired (symbol-driven + ε-closure). Drives the per-
  // step edge pulse so the user sees which arrows were taken on this
  // step. Empty for the initial step unless ε-edges were followed to
  // reach the start active set.
  const firedTransitions: ReadonlyArray<{
    from: number;
    to: number;
    symbol: string | null;
  }> = simulation?.steps[simulation.steps.length - 1]?.firedTransitions ?? [];

  // Actions
  const initialize = useCallback(
    (input: string) => dispatch({ type: 'initialize', automaton, input }),
    [automaton]
  );
  const stepForward = useCallback(() => {
    if (state.history.length >= SIMULATION_HISTORY_CAP
        && state.status !== 'finished'
        && state.status !== 'running') {
      notifyCapReached();
      return;
    }
    dispatch({ type: 'step' });
  }, [state.history.length, state.status, notifyCapReached]);
  const stepBack = useCallback(() => dispatch({ type: 'stepBack' }), []);
  const jumpTo = useCallback(
    (index: number, input?: string) =>
      dispatch({
        type: 'jumpTo',
        index,
        automaton,
        ...(input !== undefined && { input }),
      }),
    [automaton]
  );
  const run = useCallback(() => dispatch({ type: 'run' }), []);
  const pause = useCallback(() => dispatch({ type: 'pause' }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const setSpeed = useCallback(
    (speed: number) => dispatch({ type: 'setSpeed', speed }),
    []
  );

  return {
    // State
    simulation,
    status: state.status,
    speed: state.speed,
    historyIndex: state.historyIndex,
    canStepBack: state.historyIndex > 0 && state.status !== 'running',

    // Derived
    currentStateIds,
    stepIndex,
    consumedCount,
    accepted,
    dyingStateIds,
    firedTransitions,

    // Actions
    initialize,
    stepForward,
    stepBack,
    jumpTo,
    run,
    pause,
    reset,
    setSpeed,
  };
}
