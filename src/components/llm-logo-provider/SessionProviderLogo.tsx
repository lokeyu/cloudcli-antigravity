import type { LLMProvider } from '../../types/app';
import AntigravityLogo from './AntigravityLogo';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import GrokLogo from './GrokLogo';
import OpenCodeLogo from './OpenCodeLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  if (provider === 'antigravity') {
    return <AntigravityLogo className={className} />;
  }

  if (provider === 'grok') {
    return <GrokLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
