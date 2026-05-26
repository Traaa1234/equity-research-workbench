import { cn } from '@/lib/utils';

interface Props extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'outline';
}

export function Badge({ className, variant = 'default', ...props }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        variant === 'outline' ? 'border border-border text-foreground' : 'bg-secondary text-secondary-foreground',
        className
      )}
      {...props}
    />
  );
}
