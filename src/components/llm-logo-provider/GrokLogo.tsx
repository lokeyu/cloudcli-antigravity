type GrokLogoProps = {
  className?: string;
};

const GrokLogo = ({ className = 'w-5 h-5' }: GrokLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Grok"
    className={className}
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 4.5c2.4 0 4.45 1.5 5.25 3.6H13v2h7c.1.6.15 1.25.15 1.9 0 4.53-3.67 8.2-8.2 8.2-4.53 0-8.2-3.67-8.2-8.2 0-4.53 3.67-8.2 8.2-8.2zM7.2 16.8l9.6-9.6 1.4 1.4-9.6 9.6z" />
  </svg>
);

export default GrokLogo;
