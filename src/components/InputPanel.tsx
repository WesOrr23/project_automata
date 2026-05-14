/**
 * InputPanel Component
 *
 * Text input for entering test strings with per-keystroke alphabet validation.
 * Always editable — modifying the input auto-resets the simulation.
 *
 * The "Batch test" entry point lives in the top CommandBar (SIMULATE
 * segment) rather than inline here — same pattern as the EDIT-mode
 * Tools button, and stops the pill from fighting the input for space
 * in this narrow panel.
 */

type InputPanelProp = {
  /** The automaton's alphabet — used for input validation */
  alphabet: Set<string>;

  /** Controlled input value */
  input: string;

  /** Called when input changes (after filtering invalid characters) */
  onInputChange: (value: string) => void;
};

export function InputPanel({
  alphabet,
  input,
  onInputChange,
}: InputPanelProp) {
  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const rawValue = event.target.value;
    const filteredValue = [...rawValue]
      .filter((character) => alphabet.has(character))
      .join('');
    onInputChange(filteredValue);
  }

  const alphabetDisplay = Array.from(alphabet).sort().join(', ');

  return (
    <div>
      <label
        htmlFor="simulation-input"
        className="label"
        style={{ display: 'block', marginBottom: 'var(--space-2)' }}
      >
        Input
      </label>

      <input
        id="simulation-input"
        type="text"
        className="glass-input"
        value={input}
        onChange={handleChange}
        placeholder={`Symbols: ${alphabetDisplay}`}
      />
    </div>
  );
}
