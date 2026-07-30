type AntigravityLogoProps = {
  className?: string;
};

// The repo ships no Google/Gemini mark, so this is an original glyph drawn in
// the same shape-language as the other provider logos: a rounded tile with a
// rising arrow lifting off a curved surface.
const AntigravityLogo = ({ className = 'w-5 h-5' }: AntigravityLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Antigravity"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="fill-foreground" />
    <path
      d="M12 15.6V6.3M8.7 9.6 12 6.3l3.3 3.3M7.4 17.6c1.4 1.5 3 2.2 4.6 2.2s3.2-.7 4.6-2.2"
      className="stroke-background"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default AntigravityLogo;
