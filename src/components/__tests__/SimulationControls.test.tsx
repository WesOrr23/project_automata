/**
 * @vitest-environment jsdom
 *
 * RTL tests for SimulationControls. Focused on the button enable/disable
 * matrix across simulation status × hasSimulation, click dispatch on each
 * control, and the ε placeholder shown when input is empty. Result banner
 * copy is also asserted.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SimulationControls } from '../SimulationControls';
import { SIMULATION_SPEED_MIN, SIMULATION_SPEED_MAX } from '../../ui-state/constants';

function defaultProps() {
  return {
    status: 'idle' as const,
    hasSimulation: false,
    accepted: null,
    speed: SIMULATION_SPEED_MAX,
    input: 'abc',
    consumedCount: 0,
    onStep: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onStepBack: vi.fn(),
    canStepBack: false,
    onSpeedChange: vi.fn(),
    onJumpTo: vi.fn(),
  };
}

describe('SimulationControls', () => {
  it('renders Play (not Pause) when status is idle', () => {
    const { getByText, queryByText } = render(<SimulationControls {...defaultProps()} />);
    expect(getByText('Play')).toBeTruthy();
    expect(queryByText('Pause')).toBeNull();
  });

  it('renders Pause (not Play) when status is running', () => {
    const props = { ...defaultProps(), status: 'running' as const, hasSimulation: true };
    const { getByText, queryByText } = render(<SimulationControls {...props} />);
    expect(getByText('Pause')).toBeTruthy();
    expect(queryByText('Play')).toBeNull();
  });

  it('Play click invokes onPlay', () => {
    const props = defaultProps();
    const { getByText } = render(<SimulationControls {...props} />);
    fireEvent.click(getByText('Play'));
    expect(props.onPlay).toHaveBeenCalledTimes(1);
  });

  it('Pause click invokes onPause', () => {
    const props = { ...defaultProps(), status: 'running' as const, hasSimulation: true };
    const { getByText } = render(<SimulationControls {...props} />);
    fireEvent.click(getByText('Pause'));
    expect(props.onPause).toHaveBeenCalledTimes(1);
  });

  it('Step click invokes onStep when enabled', () => {
    const props = defaultProps();
    const { getByText } = render(<SimulationControls {...props} />);
    fireEvent.click(getByText('Step'));
    expect(props.onStep).toHaveBeenCalledTimes(1);
  });

  it('Step is disabled when status is finished', () => {
    const props = {
      ...defaultProps(),
      status: 'finished' as const,
      hasSimulation: true,
      accepted: true,
    };
    const { getByText } = render(<SimulationControls {...props} />);
    const button = getByText('Step').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('Back click invokes onStepBack when canStepBack', () => {
    const props = { ...defaultProps(), canStepBack: true, hasSimulation: true };
    const { getByText } = render(<SimulationControls {...props} />);
    fireEvent.click(getByText('Back'));
    expect(props.onStepBack).toHaveBeenCalledTimes(1);
  });

  it('Back is disabled when canStepBack is false', () => {
    const { getByText } = render(<SimulationControls {...defaultProps()} />);
    const button = getByText('Back').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('speed toggle: clicking Slow invokes onSpeedChange with the slow preset', () => {
    const props = defaultProps();
    const { getByText } = render(<SimulationControls {...props} />);
    fireEvent.click(getByText('Slow'));
    expect(props.onSpeedChange).toHaveBeenCalledWith(SIMULATION_SPEED_MAX);
  });

  it('speed toggle: clicking Fast invokes onSpeedChange with the fast preset', () => {
    const props = defaultProps();
    const { getByText } = render(<SimulationControls {...props} />);
    fireEvent.click(getByText('Fast'));
    expect(props.onSpeedChange).toHaveBeenCalledWith(SIMULATION_SPEED_MIN);
  });

  it('shows the ACCEPTED banner when finished + accepted', () => {
    const props = {
      ...defaultProps(),
      status: 'finished' as const,
      hasSimulation: true,
      accepted: true,
    };
    const { getByText } = render(<SimulationControls {...props} />);
    expect(getByText('ACCEPTED')).toBeTruthy();
  });

  it('shows the REJECTED banner when finished + not accepted', () => {
    const props = {
      ...defaultProps(),
      status: 'finished' as const,
      hasSimulation: true,
      accepted: false,
    };
    const { getByText } = render(<SimulationControls {...props} />);
    expect(getByText('REJECTED')).toBeTruthy();
  });

  it('input characters are clickable and dispatch onJumpTo with the index', () => {
    const props = { ...defaultProps(), input: 'xyz' };
    const { container } = render(<SimulationControls {...props} />);
    const characters = container.querySelectorAll('span');
    // Find the spans that hold individual input characters (each holds one char).
    const inputChars = Array.from(characters).filter(
      (s) => s.textContent !== null && s.textContent.length === 1 && 'xyz'.includes(s.textContent)
    );
    expect(inputChars.length).toBe(3);
    fireEvent.click(inputChars[1] as HTMLSpanElement);
    expect(props.onJumpTo).toHaveBeenCalledWith(1);
  });

  it('shows a dim ε glyph in the progress strip when input is empty', () => {
    const props = { ...defaultProps(), input: '' };
    const { getByText } = render(<SimulationControls {...props} />);
    expect(getByText('ε')).toBeTruthy();
  });

  it('Play is enabled when input is empty (empty-string ε is a valid run)', () => {
    const props = { ...defaultProps(), input: '' };
    const { getByText } = render(<SimulationControls {...props} />);
    const button = getByText('Play').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
