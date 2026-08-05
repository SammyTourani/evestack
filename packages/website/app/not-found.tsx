import { Button } from "@/components/ui/button";
import { withBase } from "@/lib/asset";
import { site } from "@/lib/copy";

export default function NotFound() {
  return (
    <div className="flex min-h-[70svh] flex-col items-center justify-center gap-6 text-center">
      <p aria-hidden className="text-heading-56 text-blue-700">
        {site.mark}
      </p>
      <h1 className="text-heading-40">Nothing at this route.</h1>
      <p className="max-w-md text-copy-16 text-gray-900">
        The stack is four layers deep, but this page isn&apos;t one of them.
      </p>
      <Button href={withBase("/")} size="lg">
        Back to evestack
      </Button>
      <p className="font-mono text-mono-13 text-gray-700">{site.motto}</p>
    </div>
  );
}
