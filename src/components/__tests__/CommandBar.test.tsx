/**
 * @vitest-environment jsdom
 *
 * RTL tests for CommandBar against the post-iter-17 layout. The bar
 * is now a four-segment context menu that changes shape with appMode:
 *
 *   FILE       — always: filename (rename) + [📂 File ▾] dropdown
 *   HISTORY    — DEFINING / EDITING when canUndo || canRedo: undo / redo
 *   EDIT       — EDITING only: [🔧 Tools ▾]
 *   SIMULATE   — SIMULATING / VIEWING: [🖼 Export ▾]
 *
 * Most of what the prior layout asserted (callbacks fire, popovers
 * open, recents render) is still verifiable — the test bodies just
 * have to open the File popover first instead of clicking standalone
 * buttons that no longer exist.
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CommandBar, type CommandBarAppMode } from '../CommandBar';

function makeProps(overrides: Partial<ComponentProps<typeof CommandBar>> = {}) {
  return {
    appMode: 'VIEWING' as CommandBarAppMode,
    currentName: null,
    isDirty: false,
    recents: [],
    onNew: vi.fn(),
    onOpen: vi.fn().mockResolvedValue(undefined),
    onSave: vi.fn().mockResolvedValue(undefined),
    onSaveAs: vi.fn().mockResolvedValue(undefined),
    onOpenRecent: vi.fn(),
    onForgetRecent: vi.fn(),
    onRenameCurrent: vi.fn(),
    canUndo: true,
    canRedo: true,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    operationsCategories: [],
    ...overrides,
  };
}

describe('CommandBar — file segment', () => {
  it('shows the File menu trigger in every appMode', () => {
    for (const mode of ['VIEWING', 'DEFINING', 'EDITING', 'SIMULATING'] as const) {
      const { getByLabelText, unmount } = render(
        <CommandBar {...makeProps({ appMode: mode })} />
      );
      expect(getByLabelText('File menu')).toBeTruthy();
      unmount();
    }
  });

  it('shows the current filename and dirty marker', () => {
    const { getByText, container } = render(
      <CommandBar {...makeProps({ currentName: 'myfa', isDirty: true })} />
    );
    expect(getByText('myfa')).toBeTruthy();
    expect(container.querySelector('.command-bar-dirty-dot')).toBeTruthy();
  });

  // The popover items don't have aria-labels — they're standard
  // <button>s with text + a keyboard-shortcut chip. The accessible
  // name is "Save⌘S" on Mac, "SaveCtrlS" on other platforms (jsdom
  // doesn't pretend to be Mac), so we look up the inner label
  // <span> by exact text and click its closest <button>. Disambig-
  // uates Save from Save As… without depending on the shortcut glyph.
  function clickFileItem(container: HTMLElement, openMenu: () => void, exactLabel: string) {
    openMenu();
    const labelSpan = Array.from(container.querySelectorAll('.command-bar-popover-item-label-inline'))
      .find((el) => el.textContent === exactLabel);
    if (!labelSpan) throw new Error(`File popover item not found: ${exactLabel}`);
    const button = labelSpan.closest('button');
    if (!button) throw new Error(`Item ${exactLabel} is not inside a <button>`);
    fireEvent.click(button);
  }

  it('opens the File popover and dispatches file callbacks', () => {
    const props = makeProps();
    const { container, getByLabelText } = render(<CommandBar {...props} />);
    const openMenu = () => fireEvent.click(getByLabelText('File menu'));
    clickFileItem(container, openMenu, 'New');
    clickFileItem(container, openMenu, 'Open…');
    clickFileItem(container, openMenu, 'Save');
    expect(props.onNew).toHaveBeenCalledTimes(1);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it('File popover exposes Save As', () => {
    const props = makeProps();
    const { container, getByLabelText } = render(<CommandBar {...props} />);
    clickFileItem(container, () => fireEvent.click(getByLabelText('File menu')), 'Save As…');
    expect(props.onSaveAs).toHaveBeenCalledTimes(1);
  });
});

describe('CommandBar — HISTORY segment (undo/redo)', () => {
  it('hides undo/redo in VIEWING', () => {
    const { queryByLabelText } = render(<CommandBar {...makeProps()} />);
    expect(queryByLabelText('Undo')).toBeNull();
    expect(queryByLabelText('Redo')).toBeNull();
  });

  it('hides undo/redo in SIMULATING', () => {
    const { queryByLabelText } = render(
      <CommandBar {...makeProps({ appMode: 'SIMULATING' })} />
    );
    expect(queryByLabelText('Undo')).toBeNull();
    expect(queryByLabelText('Redo')).toBeNull();
  });

  it('shows undo/redo in EDITING', () => {
    const { getByLabelText } = render(
      <CommandBar {...makeProps({ appMode: 'EDITING' })} />
    );
    expect(getByLabelText('Undo')).toBeTruthy();
    expect(getByLabelText('Redo')).toBeTruthy();
  });

  it('shows undo/redo in DEFINING (post-iter-12 stage-agnostic edits)', () => {
    const { getByLabelText } = render(
      <CommandBar {...makeProps({ appMode: 'DEFINING' })} />
    );
    expect(getByLabelText('Undo')).toBeTruthy();
    expect(getByLabelText('Redo')).toBeTruthy();
  });

  it('disables undo/redo when their flags are false', () => {
    const { getByLabelText } = render(
      <CommandBar {...makeProps({ appMode: 'EDITING', canUndo: false, canRedo: false })} />
    );
    expect((getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText('Redo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('dispatches undo / redo', () => {
    const props = makeProps({ appMode: 'EDITING' });
    const { getByLabelText } = render(<CommandBar {...props} />);
    fireEvent.click(getByLabelText('Undo'));
    fireEvent.click(getByLabelText('Redo'));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).toHaveBeenCalledTimes(1);
  });
});

describe('CommandBar — Recents (in File popover)', () => {
  it('renders empty-recents message inside the File popover', () => {
    const { getByLabelText, getByText } = render(<CommandBar {...makeProps()} />);
    fireEvent.click(getByLabelText('File menu'));
    expect(getByText('No recent files')).toBeTruthy();
  });

  it('lists recent entries and dispatches open / forget', () => {
    const props = makeProps({
      recents: [
        {
          id: 'a',
          name: 'foo.json',
          savedAt: new Date().toISOString(),
          openedAt: new Date().toISOString(),
          sizeBytes: 0,
          snapshot: '',
        },
      ],
    });
    const { getByLabelText, getByText } = render(<CommandBar {...props} />);
    fireEvent.click(getByLabelText('File menu'));
    fireEvent.click(getByText('foo.json'));
    expect(props.onOpenRecent).toHaveBeenCalledWith('a');

    // Re-open the popover (clicking a recent closes it).
    fireEvent.click(getByLabelText('File menu'));
    fireEvent.click(getByLabelText('Forget foo.json'));
    expect(props.onForgetRecent).toHaveBeenCalledWith('a');
  });
});

describe('CommandBar — inline rename', () => {
  it('clicking the filename swaps to a text input', () => {
    const { getByText, getByLabelText } = render(
      <CommandBar {...makeProps({ currentName: 'sample.json' })} />
    );
    fireEvent.click(getByText('sample.json'));
    const input = getByLabelText('Rename file') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('sample.json');
  });

  it('Enter commits via onRenameCurrent', () => {
    const props = makeProps({ currentName: 'old.json' });
    const { getByText, getByLabelText } = render(<CommandBar {...props} />);
    fireEvent.click(getByText('old.json'));
    const input = getByLabelText('Rename file') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new.json' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRenameCurrent).toHaveBeenCalledWith('new.json');
  });

  it('Escape discards (does not call onRenameCurrent)', () => {
    const props = makeProps({ currentName: 'old.json' });
    const { getByText, getByLabelText } = render(<CommandBar {...props} />);
    fireEvent.click(getByText('old.json'));
    const input = getByLabelText('Rename file') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new.json' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onRenameCurrent).not.toHaveBeenCalled();
  });

  it('empty rename is discarded', () => {
    const props = makeProps({ currentName: 'old.json' });
    const { getByText, getByLabelText } = render(<CommandBar {...props} />);
    fireEvent.click(getByText('old.json'));
    const input = getByLabelText('Rename file') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRenameCurrent).not.toHaveBeenCalled();
  });
});

describe('CommandBar — Tools (Operations) menu in EDIT segment', () => {
  it('renders the Tools button only in EDITING', () => {
    const cats = [
      { id: 'c', label: 'Conv', items: [{ id: 'x', label: 'X', enabled: true, onClick: vi.fn() }] },
    ];
    const viewingRender = render(<CommandBar {...makeProps({ operationsCategories: cats })} />);
    expect(viewingRender.queryByLabelText('Tools')).toBeNull();
    viewingRender.unmount();
    const editRender = render(
      <CommandBar {...makeProps({ appMode: 'EDITING', operationsCategories: cats })} />
    );
    expect(editRender.getByLabelText('Tools')).toBeTruthy();
  });

  it('clicking Tools opens a popover with the categories', () => {
    const onClick = vi.fn();
    const cats = [
      {
        id: 'c',
        label: 'Conversions',
        items: [{ id: 'x', label: 'Convert', enabled: true, onClick }],
      },
    ];
    const { getByLabelText, getByText } = render(
      <CommandBar {...makeProps({ appMode: 'EDITING', operationsCategories: cats })} />
    );
    fireEvent.click(getByLabelText('Tools'));
    expect(getByText('Conversions')).toBeTruthy();
    fireEvent.click(getByText('Convert'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('CommandBar — Export merged into File menu', () => {
  it('lists PNG and SVG items inside the File menu when handlers are provided', () => {
    const { getByLabelText, getByText } = render(
      <CommandBar {...makeProps({ onExportPNG: vi.fn(), onExportSVG: vi.fn() })} />
    );
    fireEvent.click(getByLabelText('File menu'));
    expect(getByText('Export as image')).toBeTruthy();
    expect(getByText('PNG image')).toBeTruthy();
    expect(getByText('SVG image')).toBeTruthy();
  });

  it('omits the export section entirely when no handlers are provided', () => {
    const { getByLabelText, queryByText } = render(
      <CommandBar {...makeProps()} />
    );
    fireEvent.click(getByLabelText('File menu'));
    expect(queryByText('Export as image')).toBeNull();
    expect(queryByText('PNG image')).toBeNull();
    expect(queryByText('SVG image')).toBeNull();
  });

  it('PNG click invokes onExportPNG with the transparent toggle value', () => {
    const onExportPNG = vi.fn();
    const { getByLabelText, getByText } = render(
      <CommandBar {...makeProps({ onExportPNG, onExportSVG: vi.fn() })} />
    );
    fireEvent.click(getByLabelText('File menu'));
    fireEvent.click(getByText('PNG image'));
    expect(onExportPNG).toHaveBeenCalledTimes(1);
    expect(onExportPNG).toHaveBeenCalledWith(false);
  });

  it('Export items remain available regardless of app mode (File is global)', () => {
    for (const mode of ['DEFINING', 'EDITING', 'SIMULATING', 'VIEWING'] as const) {
      const { getByLabelText, getByText, unmount } = render(
        <CommandBar {...makeProps({ appMode: mode, onExportPNG: vi.fn(), onExportSVG: vi.fn() })} />
      );
      fireEvent.click(getByLabelText('File menu'));
      expect(getByText('PNG image')).toBeTruthy();
      unmount();
    }
  });
});
