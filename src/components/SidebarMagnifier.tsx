import { ScanText } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface MagnifiedText {
  source: HTMLElement;
  left: number;
  top: number;
}

const selector = ".task-workspace.active .rail [data-magnify]";
const overlayWidth = 430;

function magnifyTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? (target.closest(selector) as HTMLElement | null)
    : null;
}

function presentationFor(element: HTMLElement): MagnifiedText | null {
  const text = element.dataset.magnify?.trim();
  if (!text) return null;
  const rect = element.getBoundingClientRect();
  const width = Math.min(overlayWidth, window.innerWidth - 32);
  const left =
    rect.left < window.innerWidth / 2
      ? Math.min(rect.right + 14, window.innerWidth - width - 16)
      : Math.max(16, rect.left - width - 14);
  const top = Math.min(
    Math.max(rect.top, 54),
    Math.max(54, window.innerHeight - 280),
  );
  return { source: element, left, top };
}

function scaledPixels(value: string, scale: number) {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) && value.endsWith("px")
    ? `${pixels * scale}px`
    : value;
}

function copyTypography(source: Element, target: Element, scale: number) {
  const computed = window.getComputedStyle(source);
  if (target instanceof HTMLElement || target instanceof SVGElement) {
    target.style.color = computed.color;
    target.style.fontFamily = computed.fontFamily;
    target.style.fontSize = scaledPixels(computed.fontSize, scale);
    target.style.fontWeight = computed.fontWeight;
    target.style.fontStyle = computed.fontStyle;
    target.style.lineHeight = scaledPixels(computed.lineHeight, scale);
    target.style.letterSpacing = computed.letterSpacing;
    target.style.textDecoration = computed.textDecoration;
    target.style.textTransform = computed.textTransform;
    target.style.textAlign = computed.textAlign;
    target.style.textShadow = computed.textShadow;
    target.style.whiteSpace = computed.whiteSpace;
    target.style.opacity = computed.opacity;
  }
  const sourceChildren = [...source.children];
  const targetChildren = [...target.children];
  sourceChildren.forEach((child, index) => {
    if (targetChildren[index]) {
      copyTypography(child, targetChildren[index], scale);
    }
  });
}

export function SidebarMagnifier() {
  const [magnified, setMagnified] = useState<MagnifiedText | null>(null);
  const cloneHost = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!magnified || !cloneHost.current) return;
    const clone = magnified.source.cloneNode(true) as HTMLElement;
    clone.removeAttribute("data-magnify");
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("tabindex", "-1");
    clone
      .querySelectorAll<HTMLElement>("[data-magnify-ignore]")
      .forEach((element) => element.remove());
    clone
      .querySelectorAll<HTMLElement>("a, button, input, select, textarea, [tabindex]")
      .forEach((element) => element.setAttribute("tabindex", "-1"));
    copyTypography(magnified.source, clone, 1.85);
    cloneHost.current.replaceChildren(clone);
  }, [magnified]);

  useEffect(() => {
    let activeElement: HTMLElement | null = null;
    const show = (target: EventTarget | null) => {
      const element = magnifyTarget(target);
      if (element === activeElement) return;
      activeElement = element;
      setMagnified(element ? presentationFor(element) : null);
    };
    const onMouseMove = (event: MouseEvent) => show(event.target);
    const onFocusIn = (event: FocusEvent) => show(event.target);
    const onFocusOut = (event: FocusEvent) => {
      const current = magnifyTarget(event.target);
      if (current && event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
        return;
      }
      activeElement = null;
      setMagnified(null);
    };
    const hide = () => {
      activeElement = null;
      setMagnified(null);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  if (!magnified) return null;
  return (
    <aside
      className="sidebar-magnifier"
      style={{ left: magnified.left, top: magnified.top }}
      aria-hidden="true"
    >
      <div className="sidebar-magnifier-label">
        <ScanText size={14} />
        Magnified text
      </div>
      <div className="sidebar-magnifier-content" ref={cloneHost} />
    </aside>
  );
}
