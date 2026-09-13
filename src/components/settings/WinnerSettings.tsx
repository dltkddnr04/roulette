import { Trophy } from 'lucide-react';
import { SegmentedControl } from './SegmentedControl';
import { SettingsRow } from './SettingsRow';

export type WinnerType = 'first' | 'last' | 'multi' | 'custom';
export type EditedRange = 'start' | 'end';

export type WinnerSettingsProps = {
  winnerType: WinnerType;
  rank: string;
  rangeStart: string;
  rangeEnd: string;
  onSelect: (type: WinnerType) => void;
  onRankChange: (value: string) => void;
  onRangeChange: (field: EditedRange, value: string) => void;
  onRangeBlur: (field: EditedRange) => void;
};

export function WinnerSettings({
  winnerType,
  rank,
  rangeStart,
  rangeEnd,
  onSelect,
  onRankChange,
  onRangeChange,
  onRangeBlur,
}: WinnerSettingsProps) {
  return (
    <>
      <SettingsRow
        className="settings-row-winner"
        label={<span data-trans>The winner is</span>}
        htmlFor="in_winningRank"
        icon={Trophy}
      >
        <SegmentedControl className="settings-winner-control">
          <button
            type="button"
            className={`btn-winner btn-first-winner${winnerType === 'first' ? ' active' : ''}`}
            data-trans
            onClick={() => onSelect('first')}
          >
            First
          </button>
          <button
            type="button"
            className={`btn-winner btn-last-winner${winnerType === 'last' ? ' active' : ''}`}
            data-trans
            onClick={() => onSelect('last')}
          >
            Last
          </button>
          <input
            type="number"
            id="in_winningRank"
            className={winnerType === 'custom' ? 'active' : ''}
            value={rank}
            min="1"
            aria-label="Custom winner rank"
            onChange={(event) => onRankChange(event.currentTarget.value)}
            onBlur={() => onSelect('custom')}
          />
          <button
            type="button"
            className={`btn-winner btn-multi-winner${winnerType === 'multi' ? ' active' : ''}`}
            data-trans
            onClick={() => onSelect('multi')}
          >
            Multiple
          </button>
        </SegmentedControl>
      </SettingsRow>
      <SettingsRow
        className={`settings-row-range${winnerType === 'multi' ? ' active' : ''}`}
        label={<span className="sr-only">Range</span>}
        htmlFor="in_rangeStart"
      >
        <SegmentedControl className="settings-range-control">
          <input
            type="number"
            id="in_rangeStart"
            value={rangeStart}
            min="1"
            aria-label="Range start"
            onChange={(event) => onRangeChange('start', event.currentTarget.value)}
            onBlur={() => onRangeBlur('start')}
          />
          <span className="range-sep">~</span>
          <input
            type="number"
            id="in_rangeEnd"
            value={rangeEnd}
            min="1"
            aria-label="Range end"
            onChange={(event) => onRangeChange('end', event.currentTarget.value)}
            onBlur={() => onRangeBlur('end')}
          />
        </SegmentedControl>
      </SettingsRow>
    </>
  );
}
