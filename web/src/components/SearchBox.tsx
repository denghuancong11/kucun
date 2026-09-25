import { useEffect, useState } from "react";
import type { ModelSummary } from "../types";
import { Badge } from "./ui";
import { Icon } from "./Icon";

/* 型号搜索框 + 候选下拉：支持 ↑↓ 键盘导航、Enter 选择、Escape 清空。 */
export function SearchBox({
  query,
  suggestions,
  onQueryChange,
  onSelect,
  onClear,
}: {
  query: string;
  suggestions: ModelSummary[];
  onQueryChange: (value: string) => void;
  onSelect: (model: ModelSummary) => void;
  onClear: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);
  /* 候选列表变化后重置高亮，避免指向已消失的项 */
  useEffect(() => {
    setActiveIndex(-1);
  }, [suggestions]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && suggestions.length > 0) {
      e.preventDefault();
      onSelect(suggestions[activeIndex >= 0 ? activeIndex : 0]);
    } else if (e.key === "Escape") {
      onClear();
    }
  };

  return (
    <div className="search-box">
      <div className="search-input">
        <Icon name="search" size={14} className="search-icon" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索型号关键字，例如 206A"
          aria-label="按型号关键字搜索"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="model-suggest-list"
          aria-activedescendant={activeIndex >= 0 ? `suggest-${activeIndex}` : undefined}
        />
        {query ? (
          <button type="button" className="search-clear" onClick={onClear} aria-label="清空搜索">
            <Icon name="x" size={13} />
          </button>
        ) : null}
      </div>
      {suggestions.length > 0 && (
        <div className="suggest-panel" role="listbox" id="model-suggest-list" aria-label="候选型号">
          {suggestions.map((m, i) => (
            <button
              key={m.model}
              id={`suggest-${i}`}
              type="button"
              className={`suggest-item${i === activeIndex ? " active" : ""}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelect(m)}
            >
              <span className="model-cell">{m.model}</span>
              {m.category && <Badge label={m.category} tone="brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
