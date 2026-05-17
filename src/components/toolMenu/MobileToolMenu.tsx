import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { ToolMenuState, ToolTabID, toolTabs } from './types';

type MobileToolMenuProp = {
  state: ToolMenuState;
  /** Called when the user taps a tab. Toggle behavior is the mobile
   *  default: tapping the active tab while OPEN closes the sheet
   *  (caller maps it onto onCollapse), tapping a different tab while
   *  OPEN switches content (caller maps it onto onTabClick). */
  onTabClick: (tab: ToolTabID) => void;
  /** Called when the user dismisses the sheet via the close button,
   *  a tap on the backdrop, or by tapping the active tab. */
  onCollapse: () => void;
  configContent: ReactNode;
  editContent: ReactNode;
  simulateContent: ReactNode;
};

/**
 * MobileToolMenu — bottom navigation + slide-up sheet.
 *
 * The mobile counterpart to ToolMenu. Three concerns make this a
 * separate component rather than a mode on ToolMenu:
 *
 *  - Geometry is inverted (tabs run horizontally along the bottom, the
 *    sheet grows upward) — the desktop component's CSS animations are
 *    keyed to a left-anchored vertical strip and don't translate.
 *  - Hover semantics (COLLAPSED ↔ EXPANDED) don't exist on touch; the
 *    sheet is binary open/closed.
 *  - The active panel animation is a vertical slide-up of a full-width
 *    sheet, which is fundamentally a different motion than the
 *    desktop's stage-1-then-stage-2 width-then-height opening.
 *
 * State model still uses the shared ToolMenuState shape so App.tsx
 * doesn't have to know which surface is rendered. We treat EXPANDED
 * the same as COLLAPSED (= sheet closed); only OPEN renders the sheet.
 *
 * Touch ergonomics:
 *  - Tab targets are 44px tall (matches --control-button-size at the
 *    mobile breakpoint, which iOS / Material recommend as the floor).
 *  - The sheet covers the canvas backdrop; tapping the backdrop or
 *    the close button collapses it. The canvas remains visible above
 *    the sheet, so users can still see what they're editing while
 *    interacting with the panel.
 *  - The sheet caps at 75vh; longer content scrolls inside the sheet
 *    rather than pushing the canvas entirely off-screen.
 */
export function MobileToolMenu({
  state,
  onTabClick,
  onCollapse,
  configContent,
  editContent,
  simulateContent,
}: MobileToolMenuProp) {
  // Mirror desktop's `displayedActiveTab` trick: keep the active tab's
  // styling through the sheet's exit animation, so the highlight
  // doesn't snap off before the sheet finishes sliding down. Cleared
  // by AnimatePresence's onExitComplete.
  const [displayedActiveTab, setDisplayedActiveTab] = useState<ToolTabID | null>(
    state.mode === 'OPEN' ? state.activeTab : null
  );
  useEffect(() => {
    if (state.mode === 'OPEN') {
      setDisplayedActiveTab(state.activeTab);
    }
  }, [state.mode, state.mode === 'OPEN' ? state.activeTab : null]);

  function contentFor(tabId: ToolTabID): ReactNode {
    switch (tabId) {
      case 'CONFIG': return configContent;
      case 'EDIT': return editContent;
      case 'SIMULATE': return simulateContent;
      default:
        const _exhaustive: never = tabId;
        return _exhaustive;
    }
  }

  function handleTab(tab: ToolTabID) {
    // Mobile toggle semantics: tapping the currently-active tab while
    // OPEN closes the sheet. Tapping a different tab while OPEN
    // switches content. Tapping any tab while CLOSED opens with it.
    if (state.mode === 'OPEN' && state.activeTab === tab) {
      onCollapse();
      return;
    }
    onTabClick(tab);
  }

  const activeTab: ToolTabID | null =
    state.mode === 'OPEN' ? state.activeTab : displayedActiveTab;

  return (
    <>
      {/* Sheet backdrop. Captures taps that would otherwise hit the
          canvas and dismisses the sheet. The backdrop is INSIDE the
          AnimatePresence so it fades in/out alongside the sheet. */}
      <AnimatePresence>
        {state.mode === 'OPEN' && (
          <motion.div
            key="mobile-sheet-backdrop"
            className="mobile-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            onClick={onCollapse}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* The sheet itself — slides up from the bottom tab bar. Body
          is the same panel content the desktop ToolMenu shows. */}
      <AnimatePresence onExitComplete={() => setDisplayedActiveTab(null)}>
        {state.mode === 'OPEN' && (
          <motion.div
            key={`mobile-sheet-${state.activeTab}`}
            className="mobile-sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            role="dialog"
            aria-modal="false"
            aria-label={toolTabs.find((t) => t.id === state.activeTab)?.label ?? 'Panel'}
          >
            <div className="mobile-sheet-header">
              <span className="mobile-sheet-title">
                {toolTabs.find((t) => t.id === state.activeTab)?.label}
              </span>
              <button
                type="button"
                className="mobile-sheet-close"
                onClick={onCollapse}
                aria-label="Close panel"
                title="Close panel"
              >
                <X size={18} />
              </button>
            </div>
            <div className="mobile-sheet-body">
              {contentFor(state.activeTab)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom tab bar — always visible. Each tab is a 44px-tall
          target with icon + label. Active tab gets blue chrome. */}
      <nav className="mobile-tab-bar" aria-label="Tool tabs">
        {toolTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className={`mobile-tab${isActive ? ' mobile-tab-active' : ''}`}
              onClick={() => handleTab(tab.id)}
              aria-label={tab.label}
              aria-pressed={isActive}
            >
              <Icon size={20} />
              <span className="mobile-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
