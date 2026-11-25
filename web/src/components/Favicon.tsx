import { useState } from 'react';
import { faviconUrl } from '../lib/search-results';

/** favicon 图片，加载失败回退成域名首字符色块 */
export default function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);
  const letter = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')[0].toUpperCase();
    } catch {
      return '?';
    }
  })();
  if (failed || !src) return <span className="favicon fallback">{letter}</span>;
  return <img className="favicon" src={src} alt="" onError={() => setFailed(true)} />;
}
