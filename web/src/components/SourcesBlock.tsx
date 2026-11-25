import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ParsedResult } from '../lib/search-results';
import Favicon from './Favicon';

/** 正文末尾 Sources: 段 → 可折叠的「N 个来源」条（元宝风格） */
export default function SourcesBlock({ items }: { items: ParsedResult[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="sources-block">
      <button className="sources-bar answer-sources-bar" onClick={() => setOpen((v) => !v)}>
        <span className="favicon-stack">
          {items.slice(0, 4).map((r, i) => <Favicon key={i} url={r.url} />)}
        </span>
        <span className="sources-count">{items.length} 个来源</span>
        <ChevronDown size={12} className={open ? 'rot' : ''} />
      </button>
      {open && (
        <ul className="sources-list">
          {items.map((r, i) => (
            <li key={i}><a href={r.url} target="_blank" rel="noreferrer">{r.title}</a></li>
          ))}
        </ul>
      )}
    </div>
  );
}
