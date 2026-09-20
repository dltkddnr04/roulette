import { Play, Shuffle } from 'lucide-react';

export type ParticipantInputProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onShuffle: () => void;
  onStart: () => void;
  readOnly?: boolean;
  startDisabled?: boolean;
};

export function ParticipantInput({
  value,
  onChange,
  onBlur,
  onShuffle,
  onStart,
  readOnly = false,
  startDisabled = false,
}: ParticipantInputProps) {
  return (
    <div className="left">
      <h3 data-trans>Enter names below</h3>
      <textarea
        id="in_names"
        placeholder="Input names separated by commas or line feed here"
        data-trans="placeholder"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
      />
      <div className="actions">
        <div className="sep"></div>
        <button id="btnShuffle" type="button" onClick={onShuffle} disabled={readOnly}>
          <Shuffle className="settings-icon" aria-hidden="true" />
          <span data-trans>Shuffle</span>
        </button>
        <button id="btnStart" type="button" onClick={onStart} disabled={startDisabled}>
          <Play className="settings-icon" aria-hidden="true" />
          <span data-trans>Start</span>
        </button>
      </div>
    </div>
  );
}
