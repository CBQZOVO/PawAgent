import { isValidElement, memo, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Components } from 'react-markdown';
import { Check, Code2, Copy, Eye, Maximize2, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { detectMermaidLabel, isMermaidLanguage, isSafeMermaidSvg, textFromChildren } from '../lib/markdown-mermaid';

/** mermaid 渲染时会往 body 挂临时节点，固定 id 在并发/双跑时会撞车，所以每次渲染递增 */
let renderSeq = 0;

/** 单例加载并初始化 mermaid：并发挂载多个图时只初始化一次，不产生竞态 */
let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null;
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const m = mod.default;
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        // base 主题 + Paw 浅色品牌调色板：柔蓝灰节点 / 清爽子图 / 清晰文字对比度
        theme: 'base',
        themeVariables: {
          background: '#ffffff',
          primaryColor: '#eff6ff',
          primaryTextColor: '#1e293b',
          primaryBorderColor: '#93c5fd',
          secondaryColor: '#f8fafc',
          secondaryTextColor: '#334155',
          secondaryBorderColor: '#cbd5e1',
          tertiaryColor: '#ffffff',
          tertiaryBorderColor: '#e2e8f0',
          clusterBkg: '#f8fafc',
          clusterBorder: '#cbd5e1',
          edgeLabelBackground: '#ffffff',
          lineColor: '#64748b',
          titleColor: '#0f172a',
          actorBkg: '#eff6ff',
          actorBorder: '#93c5fd',
          actorTextColor: '#1e293b',
          signalColor: '#475569',
          noteBkgColor: '#fefce8',
          noteBorderColor: '#fde047',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
          fontSize: '14px',
        },
        flowchart: {
          curve: 'basis',
          htmlLabels: true,
          nodeSpacing: 38,
          rankSpacing: 46,
          padding: 14,
        },
        sequence: {
          diagramMarginX: 24,
          diagramMarginY: 16,
          actorMargin: 48,
          boxMargin: 10,
          messageMargin: 32,
        },
      });
      return m;
    }).catch((err) => {
      // 加载失败清空缓存，允许下次重试
      mermaidPromise = null;
      throw err;
    });
  }
  return mermaidPromise;
}

/** 串行渲染队列：mermaid 内部有全局解析器/测量容器，多图同帧并发渲染容易串台且卡主线程 */
let renderQueue: Promise<unknown> = Promise.resolve();
function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const next = renderQueue.then(task, task);
  renderQueue = next.catch(() => undefined);
  return next;
}

/** LRU SVG 缓存（按源码索引）：切会话、切文件、流式续写时命中即 0ms 渲染，不再闪白 */
const MAX_CACHE = 64;
const svgCache = new Map<string, string>();
function cacheGet(code: string): string | undefined {
  const hit = svgCache.get(code);
  if (hit !== undefined) {
    svgCache.delete(code);
    svgCache.set(code, hit);
  }
  return hit;
}
function cacheSet(code: string, svg: string) {
  if (svgCache.has(code)) svgCache.delete(code);
  svgCache.set(code, svg);
  if (svgCache.size > MAX_CACHE) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;
const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;

/**
 * 一段 Mermaid 图：
 * - 按需加载 mermaid + 视口懒渲染（IntersectionObserver，提前 300px 触发），不拖慢长文档首屏；
 * - LRU 缓存 + 220ms 防抖 + 串行队列：流式生成时不逐字报错闪烁、多图并发不卡主线程；
 * - 内置缩放、全屏预览、源码切换与一键复制，大图不糊、小图不拉伸。
 */
const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const hostRef = useRef<HTMLDivElement>(null);
  const cached = cacheGet(code);
  const [svg, setSvg] = useState<string | null>(() => cached ?? null);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(() => cached !== undefined || typeof IntersectionObserver === 'undefined');
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [modalZoom, setModalZoom] = useState(1);
  const [copied, setCopied] = useState(false);

  // 离屏图表暂不触发渲染，滚到距视口 300px 内再开始
  useEffect(() => {
    if (visible) return;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const hit = cacheGet(code);
    if (hit !== undefined) {
      setSvg(hit);
      setError('');
      return;
    }
    if (!code) {
      setSvg(null);
      setError('');
      return;
    }

    let cancelled = false;
    // 防抖 220ms：流式输出逐 token 变化时不反复调 mermaid.render()，也避免中途狂闪语法错误
    const timer = setTimeout(() => {
      void enqueueRender(async () => {
        if (cancelled) return;
        const id = `paw-mermaid-${baseId}-${++renderSeq}`;
        try {
          const mermaid = await getMermaid();
          if (cancelled) return;
          const result = await mermaid.render(id, code);
          if (cancelled) return;
          const out = result.svg.trimStart();
          if (!isSafeMermaidSvg(out)) {
            throw new Error('图表输出含不安全内容');
          }
          cacheSet(code, out);
          setSvg(out);
          setError('');
        } catch (e) {
          if (!cancelled) setError((e as Error).message?.trim() || '图表语法错误');
        } finally {
          // 清理 mermaid 渲染或失败时可能残留在 body 里的临时节点
          document.getElementById(id)?.remove();
          document.getElementById(`d${id}`)?.remove();
        }
      });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [baseId, code, visible]);

  // 全屏预览按 Esc 关闭
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const copySource = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  };

  const label = detectMermaidLabel(code);
  const canShowDiagram = !!svg && !showSource;

  return (
    <div ref={hostRef} className={'mermaid-block' + (error && !svg ? ' mermaid-error' : '')}>
      <div className="mermaid-bar">
        <span className="mermaid-tag">{label}</span>
        <div className="mermaid-tools">
          {canShowDiagram && (
            <>
              <button
                type="button"
                className="mermaid-tool-btn"
                title="缩小"
                aria-label="缩小图表"
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
              >
                <Minus size={13} />
              </button>
              <button
                type="button"
                className="mermaid-tool-btn mermaid-zoom-val"
                title="点击重置缩放"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="mermaid-tool-btn"
                title="放大"
                aria-label="放大图表"
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
              >
                <Plus size={13} />
              </button>
              <span className="mermaid-tool-sep" />
              <button
                type="button"
                className="mermaid-tool-btn"
                title="全屏查看"
                aria-label="全屏查看图表"
                onClick={() => { setModalZoom(1); setExpanded(true); }}
              >
                <Maximize2 size={13} />
              </button>
            </>
          )}
          {svg && (
            <button
              type="button"
              className={'mermaid-tool-btn' + (showSource ? ' active' : '')}
              title={showSource ? '切回图表' : '查看源码'}
              onClick={() => setShowSource((v) => !v)}
            >
              {showSource ? <Eye size={13} /> : <Code2 size={13} />}
              <span>{showSource ? '图表' : '源码'}</span>
            </button>
          )}
          <button
            type="button"
            className="mermaid-tool-btn"
            title="复制 Mermaid 源码"
            onClick={copySource}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>

      {showSource ? (
        <pre className="mermaid-source">{code}</pre>
      ) : svg ? (
        <div className="mermaid-canvas">
          <div
            className="mermaid-stage"
            style={zoom !== 1 ? { width: `${Math.round(zoom * 100)}%` } : undefined}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          {error && <div className="mermaid-inline-warn">最新片段语法未闭合或有误：{error}</div>}
        </div>
      ) : error ? (
        <div className="mermaid-error-body">
          <div className="mermaid-error-head">Mermaid 图渲染失败：{error}</div>
          <pre className="mermaid-source">{code}</pre>
        </div>
      ) : (
        <div className="mermaid-loading">
          <span className="mermaid-loading-dot" />
          <span>正在渲染图表…</span>
        </div>
      )}

      {expanded && svg && createPortal(
        <div className="mermaid-lightbox" role="dialog" aria-modal="true" onClick={() => setExpanded(false)}>
          <div className="mermaid-lightbox-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mermaid-lightbox-head">
              <span className="mermaid-tag">{label}</span>
              <div className="mermaid-tools">
                <button
                  type="button"
                  className="mermaid-tool-btn"
                  title="缩小"
                  disabled={modalZoom <= ZOOM_MIN}
                  onClick={() => setModalZoom((z) => clampZoom(z - ZOOM_STEP))}
                >
                  <Minus size={14} />
                </button>
                <button
                  type="button"
                  className="mermaid-tool-btn mermaid-zoom-val"
                  title="重置缩放"
                  onClick={() => setModalZoom(1)}
                >
                  {Math.round(modalZoom * 100)}%
                </button>
                <button
                  type="button"
                  className="mermaid-tool-btn"
                  title="放大"
                  disabled={modalZoom >= ZOOM_MAX}
                  onClick={() => setModalZoom((z) => clampZoom(z + ZOOM_STEP))}
                >
                  <Plus size={14} />
                </button>
                {modalZoom !== 1 && (
                  <button
                    type="button"
                    className="mermaid-tool-btn"
                    title="还原 100%"
                    onClick={() => setModalZoom(1)}
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
                <span className="mermaid-tool-sep" />
                <button
                  type="button"
                  className="mermaid-tool-btn"
                  title="关闭 (Esc)"
                  aria-label="关闭全屏预览"
                  onClick={() => setExpanded(false)}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <div className="mermaid-lightbox-body">
              <div
                className="mermaid-stage"
                style={modalZoom !== 1 ? { width: `${Math.round(modalZoom * 100)}%` } : undefined}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});

/** 两处 Markdown 渲染共用：在 pre 层拦截 language-mermaid，普通代码块原样走 */
export const mermaidComponents: Components = {
  pre: ({ children, ...props }) => {
    const first = Array.isArray(children) ? children[0] : children;
    const className = isValidElement<{ className?: unknown }>(first) ? first.props.className : undefined;
    if (isMermaidLanguage(className)) {
      return <MermaidBlock code={textFromChildren(first).trim()} />;
    }
    return <pre {...props}>{children}</pre>;
  },
};
