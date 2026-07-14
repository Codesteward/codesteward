/**
 * Official Codesteward brand marks from https://codesteward.ai/
 * and github.com/Codesteward/codesteward assets.
 *
 * - icon: feather + <> mark (codesteward-icon.png)
 * - wordmark: full logo with "codesteward" + tagline (codesteward-wordmark.png)
 */
type LogoVariant = "icon" | "wordmark";

export function Logo({
  size = 34,
  variant = "icon",
  className = "logo-mark",
  title = "Codesteward",
}: {
  size?: number;
  variant?: LogoVariant;
  className?: string;
  title?: string;
}) {
  if (variant === "wordmark") {
    return (
      <img
        className={`${className} logo-wordmark`}
        src="/brand/codesteward-wordmark.png"
        alt={title}
        height={size}
        style={{ height: size, width: "auto", display: "block" }}
        draggable={false}
      />
    );
  }

  return (
    <img
      className={`${className} logo-icon`}
      src="/brand/codesteward-icon.png"
      alt={title}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block", objectFit: "contain" }}
      draggable={false}
    />
  );
}
