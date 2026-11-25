import { useState } from 'react';
import { Boxes, Link2, Plug, Sparkles } from 'lucide-react';
import McpPage from './McpPage';
import SkillsPage from './SkillsPage';
import PluginsPage from './PluginsPage';
import ConnectionsPage from './ConnectionsPage';

export type ToolsTab = 'mcp' | 'skills' | 'plugins' | 'connections';

/**
 * MCP · SKILL · 插件 · 系统连接共用页面：顶部 tab 切换，各子页保持各自状态。
 */
export default function ToolsPage({ initialTab = 'mcp' }: { initialTab?: ToolsTab }) {
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
      </div>
      <div className="tools-body">
        <div style={{ display: tab === 'mcp' ? undefined : 'none' }}><McpPage /></div>
        <div style={{ display: tab === 'skills' ? undefined : 'none' }}><SkillsPage /></div>
        <div style={{ display: tab === 'plugins' ? undefined : 'none' }}><PluginsPage /></div>
        <div style={{ display: tab === 'connections' ? undefined : 'none' }}><ConnectionsPage /></div>
      </div>
    </div>
  );
}
