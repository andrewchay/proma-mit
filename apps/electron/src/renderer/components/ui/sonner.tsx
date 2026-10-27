import { useAtomValue } from "jotai"
import { Toaster as Sonner } from "sonner"
import { resolvedThemeAtom } from "@/atoms/theme"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAtomValue(resolvedThemeAtom)

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="top-center"
      offset={58}
      className="toaster group titlebar-no-drag"
      toastOptions={{
        classNames: {
          toast:
            "group toast titlebar-no-drag group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "titlebar-no-drag group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "titlebar-no-drag group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
