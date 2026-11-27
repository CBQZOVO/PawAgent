import { useState } from 'react';
import { Boxes, Link2, Plug, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import McpPage from './McpPage';
import SkillsPage from './SkillsPage';
import PluginsPage from './PluginsPage';
import ConnectionsPage from './ConnectionsPage';

export type ToolsTab = 'mcp' | 'skills' | 'plugins' | 'connections' | 'permissions';

/**
 * MCP · SKILL · 插件 · 系统连接 · 全局许可共用页面：顶部 tab 切换，各子页保持各自状态。
 */
export default function ToolsPage({ initialTab = 'mcp', globalAllow, onRemoveGlobal }: {
  initialTab?: ToolsTab;
  globalAllow: string[];
  onRemoveGlobal: (tool: string) => void;
}) {
  const [tab, setTab] = useState<ToolsTab>(initialTab);
  return (
    <div className="tools-page">
      <div className="tools-tabs">
        <button className={'tools-tab' + (tab === 'mcp' ? ' active' : '')} onClick={() => setTab('mcp')}>
          <Plug size={15} /> MCP
        </button>
        <button className={'tools-tab' + (tab === 'skills' ? ' active' : '')} onClick={() => setTab('skills')}>
          <Sparkles size={15} /> SKILL
        </button>
        <button className={'tools-tab' + (tab === 'plugins' ? ' active' : '')} onClick={() => setTab('plugins')}>
          <Boxes size={15} /> 插件
        </button>
        <button className={'tools-tab' + (tab === 'connections' ? ' active' : '')} onClick={() => setTab('connections')}>
          <Link2 size={15} /> 系统连接
        </button>
        <button className={'tools-tab' + (tab === 'permissions' ? ' active' : '')} onClick={() => setTab('permissions')}>
          <ShieldCheck size={15} /> 全局许可
        </button>
      </div>
      <div className="tools-body">
        <div style={{ display: tab === 'mcp' ? undefined : 'none' }}><McpPage /></div>
        <div style={{ display: tab === 'skills' ? undefined : 'none' }}><SkillsPage /></div>
        <div style={{ display: tab === 'plugins' ? undefined : 'none' }}><PluginsPage /></div>
        <div style={{ display: tab === 'connections' ? undefined : 'none' }}><ConnectionsPage /></div>
        <div style={{ display: tab === 'permissions' ? undefined : 'none' }}>
          <div className="perm-global-page">
            <div className="perm-global-head">全局工具许可</div>
            <p className="perm-global-note">仅作为之后新建会话的默认许可；已有会话不受追溯影响。run_command 与 call_api 不能全局放行。</p>
            {globalAllow.length === 0 ? (
              <div className="perm-global-empty">尚未设置全局许可。</div>
            ) : (
              <div className="perm-global-list">
                {globalAllow.map((tool) => (
                  <div className="perm-global-row" key={tool}>
                    <code>{tool}</code>
                    <button type="button" title="移除该全局许可" onClick={() => onRemoveGlobal(tool)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
