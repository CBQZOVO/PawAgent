import { useEffect, useRef } from 'react';
import { Check, ChevronDown, Eye } from 'lucide-react';
import type { ModelInfo } from '../api/client';
import { canSeeImages } from '../lib/model-caps';
import ModelLogo from './ModelLogo';

/** 输入栏右侧的模型选择：按钮 + 搜索下拉（受控组件） */
export default function ModelMenu({
  model, models, open, search, refreshing,
  onToggle, onClose, onSearch, onSelect,
}: {
  model: string;
  models: ModelInfo[];
  open: boolean;
  search: string;
  refreshing: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSearch: (s: string) => void;
  onSelect: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);
  const groups = models
    .filter((m) => m.id.toLowerCase().includes(search.toLowerCase()))
    .reduce<Record<string, ModelInfo[]>>((g, m) => {
      (g[m.group] ||= []).push(m);
      return g;
    }, {});
  return (
    <div className="model-wrap" ref={wrapRef}>
      <button className="model-btn" onClick={onToggle} title={model || '模型不可用'}>
        {model && <ModelLogo model={model} size={16} />}
        <span className="model-btn-name">{model || '模型不可用'}</span><ChevronDown size={12} />
      </button>
      {open && (
        <div className="model-menu popup-up">
          <div className="model-search">
            <input autoFocus value={search} onChange={(e) => onSearch(e.target.value)}
              placeholder={refreshing ? '正在刷新模型列表…' : '搜索模型…'} />
            {refreshing && <div className="model-refresh-tip">正在从 /v1/models 刷新…</div>}
          </div>
          <div className="model-list">
            {Object.entries(groups).map(([group, list]) => (
              <div key={group}>
                <div className="model-group">{group}</div>
                {list.map((m) => (
                  <button
                    key={m.id}
                    className={'popup-item' + (m.id === model ? ' selected' : '')}
                    onClick={() => onSelect(m.id)}
                  >
                    <span className="model-item-name"><ModelLogo model={m.id} size={15} /> {m.id}</span>
                    {canSeeImages(m.id) && <span title="支持读图" className="vision-mark"><Eye size={12} /></span>}
                    {m.id === model && <Check size={13} />}
                  </button>
                ))}
              </div>
            ))}
            {models.length === 0 && <div className="popup-hint">加载失败，请检查网关</div>}
          </div>
        </div>
      )}
    </div>
  );
}
