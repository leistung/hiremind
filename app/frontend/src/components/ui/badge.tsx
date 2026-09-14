import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold", { variants: { variant: { default: "bg-slate-100 text-slate-600", success: "bg-emerald-50 text-emerald-700", progress: "bg-violet-50 text-violet-700", warning: "bg-orange-50 text-orange-700" } }, defaultVariants: { variant: "default" } });
export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) { return <div className={cn(badgeVariants({ variant }), className)} {...props} />; }
