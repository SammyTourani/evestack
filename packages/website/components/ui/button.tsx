import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-gray-1000 text-background-100 hover:opacity-90 border border-transparent",
  secondary:
    "border border-border-default text-gray-1000 hover:border-border-strong bg-transparent",
  ghost: "text-gray-900 hover:text-gray-1000 border border-transparent",
};

const sizeClasses = {
  md: "h-10 px-4 text-copy-14",
  lg: "h-12 px-6 text-copy-16",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  href,
  external,
  className,
  children,
  ...rest
}: {
  variant?: Variant;
  size?: keyof typeof sizeClasses;
  href?: string;
  external?: boolean;
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = cn(
    "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-[opacity,border-color,color] duration-150 select-none",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
  if (href) {
    return (
      <a
        href={href}
        className={classes}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  }
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
