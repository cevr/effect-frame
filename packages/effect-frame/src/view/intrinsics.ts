import type { Attached, Bound, Prepared } from "./view.js";
import type { Child } from "./jsx-runtime.js";

/**
 * The HTML tags a view may write, and the props each one takes. The DOM,
 * HTML, and Remote hosts share this map; a terminal file names its own with
 * `@jsxImportSource effect-frame/view/opentui`.
 *
 * A prop is the attribute as HTML spells it (`class`, `for`, `tabindex`),
 * and the host writes it under that name. A value is written once, or bound
 * to a source with `View.bind`. An `on*` prop is an event the host listens
 * for under the prop's name in lowercase (`onKeyDown` is `keydown`), and
 * takes a prepared handler (`View.event`, `View.submit`).
 *
 * A mistake the compiler can name is named: a raw source or a plain
 * function in a slot carries a member whose missing key is the fix.
 */

// ---------------------------------------------------------------------------
// Named errors
// ---------------------------------------------------------------------------

/**
 * A raw `Source` where a value goes. No value has this type: a `Source` is
 * its closest match, so the compiler reports the missing key, which is the
 * fix.
 */
export interface SourceNeedsBind {
  readonly get: unknown;
  readonly changes: unknown;
  readonly "wrap the source with View.bind(source)": never;
}

/**
 * A plain function where a handler goes. A function is its closest match,
 * so the compiler reports the missing key of what it returns, the fix.
 */
export interface HandlerNeedsEvent {
  (...args: never): { readonly "wrap the handler with View.event(handler)": never };
}

/** A child of an element that holds none (`input`, `img`, `br`). No value has this type. */
export interface VoidElementHoldsNoChildren {
  readonly "a void element holds no children": never;
}

/**
 * A form's `method` or `action`. No value has this type: a form posts with
 * no script only through a `View.form` binding, whose plain post the
 * runtime writes as both.
 */
export interface WrittenByViewForm {
  readonly "the runtime writes a command form's method and action from View.form": never;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** An attribute's value: written once, or bound to a source. */
export type Attr<A> = A | Bound<A> | SourceNeedsBind;

/** What an element holds between its tags. */
export type Children = Child | SourceNeedsBind | ReadonlyArray<Children>;

/** An event prop: a prepared handler of any kind. */
export type On = Prepared | HandlerNeedsEvent;

/** A value of the `on`/`off` enumerations HTML spells as words. */
type OnOff = "on" | "off";

type CrossOrigin = "anonymous" | "use-credentials" | "";

type ReferrerPolicy =
  | ""
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

// ---------------------------------------------------------------------------
// Every element
// ---------------------------------------------------------------------------

/** The events every element may listen for. */
export interface EventProps {
  readonly onAbort?: On;
  readonly onAnimationEnd?: On;
  readonly onAnimationIteration?: On;
  readonly onAnimationStart?: On;
  readonly onAuxClick?: On;
  readonly onBeforeInput?: On;
  readonly onBlur?: On;
  readonly onChange?: On;
  readonly onClick?: On;
  readonly onContextMenu?: On;
  readonly onCopy?: On;
  readonly onCut?: On;
  readonly onDblClick?: On;
  readonly onDrag?: On;
  readonly onDragEnd?: On;
  readonly onDragEnter?: On;
  readonly onDragLeave?: On;
  readonly onDragOver?: On;
  readonly onDragStart?: On;
  readonly onDrop?: On;
  readonly onError?: On;
  readonly onFocus?: On;
  readonly onFocusIn?: On;
  readonly onFocusOut?: On;
  readonly onInput?: On;
  readonly onInvalid?: On;
  readonly onKeyDown?: On;
  readonly onKeyUp?: On;
  readonly onLoad?: On;
  readonly onMouseDown?: On;
  readonly onMouseEnter?: On;
  readonly onMouseLeave?: On;
  readonly onMouseMove?: On;
  readonly onMouseOut?: On;
  readonly onMouseOver?: On;
  readonly onMouseUp?: On;
  readonly onPaste?: On;
  readonly onPointerCancel?: On;
  readonly onPointerDown?: On;
  readonly onPointerEnter?: On;
  readonly onPointerLeave?: On;
  readonly onPointerMove?: On;
  readonly onPointerOut?: On;
  readonly onPointerOver?: On;
  readonly onPointerUp?: On;
  readonly onScroll?: On;
  readonly onScrollEnd?: On;
  readonly onSelect?: On;
  readonly onToggle?: On;
  readonly onTouchCancel?: On;
  readonly onTouchEnd?: On;
  readonly onTouchMove?: On;
  readonly onTouchStart?: On;
  readonly onTransitionEnd?: On;
  readonly onWheel?: On;
}

/** The attributes every element takes, its behaviours, and its events. */
export interface GlobalProps extends EventProps {
  readonly accesskey?: Attr<string>;
  readonly autocapitalize?: Attr<"off" | "none" | "on" | "sentences" | "words" | "characters">;
  readonly autofocus?: Attr<boolean>;
  readonly class?: Attr<string>;
  readonly contenteditable?: Attr<boolean | "true" | "false" | "plaintext-only" | "inherit" | "">;
  readonly dir?: Attr<"ltr" | "rtl" | "auto">;
  readonly draggable?: Attr<"true" | "false">;
  readonly enterkeyhint?: Attr<"enter" | "done" | "go" | "next" | "previous" | "search" | "send">;
  readonly hidden?: Attr<boolean | "until-found">;
  readonly id?: Attr<string>;
  readonly inert?: Attr<boolean>;
  readonly inputmode?: Attr<
    "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url"
  >;
  readonly itemid?: Attr<string>;
  readonly itemprop?: Attr<string>;
  readonly itemref?: Attr<string>;
  readonly itemscope?: Attr<boolean>;
  readonly itemtype?: Attr<string>;
  readonly lang?: Attr<string>;
  readonly nonce?: Attr<string>;
  readonly popover?: Attr<"auto" | "manual" | "hint" | "">;
  readonly role?: Attr<string>;
  readonly slot?: Attr<string>;
  readonly spellcheck?: Attr<boolean | "true" | "false">;
  readonly style?: Attr<string>;
  readonly tabindex?: Attr<number | string>;
  readonly title?: Attr<string>;
  readonly translate?: Attr<"yes" | "no">;
  readonly [aria: `aria-${string}`]: Attr<string | number | boolean>;
  readonly [data: `data-${string}`]: Attr<string | number | boolean>;
  /** Behaviours run with the host node once it is in the document (`View.attach`). */
  readonly attach?: Attached<unknown> | ReadonlyArray<Attached<unknown>>;
  readonly children?: Children;
}

/** An element that holds no children: `<input />`, `<img />`, `<br />`. */
export interface VoidProps extends Omit<GlobalProps, "children"> {
  readonly children?: VoidElementHoldsNoChildren;
}

// ---------------------------------------------------------------------------
// Elements with attributes of their own
// ---------------------------------------------------------------------------

export interface AnchorProps extends GlobalProps {
  readonly download?: Attr<string | boolean>;
  readonly href?: Attr<string>;
  readonly hreflang?: Attr<string>;
  /** Obsolete, and still a fragment target the platform scrolls to. */
  readonly name?: Attr<string>;
  readonly ping?: Attr<string>;
  readonly referrerpolicy?: Attr<ReferrerPolicy>;
  readonly rel?: Attr<string>;
  readonly target?: Attr<string>;
  readonly type?: Attr<string>;
}

export interface AreaProps extends VoidProps {
  readonly alt?: Attr<string>;
  readonly coords?: Attr<string>;
  readonly download?: Attr<string | boolean>;
  readonly href?: Attr<string>;
  readonly ping?: Attr<string>;
  readonly referrerpolicy?: Attr<ReferrerPolicy>;
  readonly rel?: Attr<string>;
  // oxlint-disable-next-line effect/noShapeInSymbolNames -- HTML names this attribute `shape`.
  readonly shape?: Attr<"rect" | "circle" | "poly" | "default">;
  readonly target?: Attr<string>;
}

/** What the audio and video elements share. */
export interface MediaProps extends GlobalProps {
  readonly autoplay?: Attr<boolean>;
  readonly controls?: Attr<boolean>;
  readonly crossorigin?: Attr<CrossOrigin>;
  readonly loop?: Attr<boolean>;
  readonly muted?: Attr<boolean>;
  readonly preload?: Attr<"none" | "metadata" | "auto" | "">;
  readonly src?: Attr<string>;
  readonly onCanPlay?: On;
  readonly onCanPlayThrough?: On;
  readonly onDurationChange?: On;
  readonly onEmptied?: On;
  readonly onEnded?: On;
  readonly onLoadedData?: On;
  readonly onLoadedMetadata?: On;
  readonly onLoadStart?: On;
  readonly onPause?: On;
  readonly onPlay?: On;
  readonly onPlaying?: On;
  readonly onProgress?: On;
  readonly onRateChange?: On;
  readonly onSeeked?: On;
  readonly onSeeking?: On;
  readonly onStalled?: On;
  readonly onSuspend?: On;
  readonly onTimeUpdate?: On;
  readonly onVolumeChange?: On;
  readonly onWaiting?: On;
}

export interface VideoProps extends MediaProps {
  readonly height?: Attr<number | string>;
  readonly playsinline?: Attr<boolean>;
  readonly poster?: Attr<string>;
  readonly width?: Attr<number | string>;
}

export interface BaseProps extends VoidProps {
  readonly href?: Attr<string>;
  readonly target?: Attr<string>;
}

export interface QuoteProps extends GlobalProps {
  readonly cite?: Attr<string>;
}

/** What the controls of a form share. */
export interface ControlProps {
  readonly disabled?: Attr<boolean>;
  readonly form?: Attr<string>;
  readonly name?: Attr<string>;
}

export interface ButtonProps extends GlobalProps, ControlProps {
  readonly formaction?: Attr<string>;
  readonly formenctype?: Attr<string>;
  readonly formmethod?: Attr<"get" | "post" | "dialog">;
  readonly formnovalidate?: Attr<boolean>;
  readonly formtarget?: Attr<string>;
  readonly popovertarget?: Attr<string>;
  readonly popovertargetaction?: Attr<"toggle" | "show" | "hide">;
  readonly type?: Attr<"button" | "submit" | "reset">;
  readonly value?: Attr<string | number>;
}

export interface CanvasProps extends GlobalProps {
  readonly height?: Attr<number | string>;
  readonly width?: Attr<number | string>;
}

export interface ColProps extends VoidProps {
  readonly span?: Attr<number>;
}

export interface ColgroupProps extends GlobalProps {
  readonly span?: Attr<number>;
}

export interface DataProps extends GlobalProps {
  readonly value?: Attr<string | number>;
}

export interface DetailsProps extends GlobalProps {
  readonly name?: Attr<string>;
  readonly open?: Attr<boolean>;
}

export interface DialogProps extends GlobalProps {
  readonly open?: Attr<boolean>;
  readonly onCancel?: On;
  readonly onClose?: On;
}

export interface EditProps extends GlobalProps {
  readonly cite?: Attr<string>;
  readonly datetime?: Attr<string>;
}

export interface EmbedProps extends VoidProps {
  readonly height?: Attr<number | string>;
  readonly src?: Attr<string>;
  readonly type?: Attr<string>;
  readonly width?: Attr<number | string>;
}

export interface FieldsetProps extends GlobalProps, ControlProps {}

/**
 * A form. `onSubmit` takes a handler that suppresses the host's default
 * post (`View.submit`, or a `View.form` binding's `submit`): with
 * `View.event` the browser would post natively. A form posts with no script
 * only through a `View.form` binding, and the runtime writes its `method`
 * and `action`, so a view writes neither.
 */
export interface FormProps extends GlobalProps {
  readonly "accept-charset"?: Attr<string>;
  readonly autocomplete?: Attr<OnOff>;
  readonly enctype?: Attr<string>;
  readonly name?: Attr<string>;
  readonly novalidate?: Attr<boolean>;
  readonly rel?: Attr<string>;
  readonly target?: Attr<string>;
  readonly action?: WrittenByViewForm;
  readonly method?: WrittenByViewForm;
  readonly onReset?: On;
  readonly onSubmit?: Prepared<"submit"> | HandlerNeedsEvent;
}

export interface HtmlProps extends GlobalProps {
  readonly xmlns?: Attr<string>;
}

export interface IframeProps extends GlobalProps {
  readonly allow?: Attr<string>;
  readonly allowfullscreen?: Attr<boolean>;
  readonly height?: Attr<number | string>;
  readonly loading?: Attr<"eager" | "lazy">;
  readonly name?: Attr<string>;
  readonly referrerpolicy?: Attr<ReferrerPolicy>;
  readonly sandbox?: Attr<string>;
  readonly src?: Attr<string>;
  readonly srcdoc?: Attr<string>;
  readonly width?: Attr<number | string>;
}

export interface ImgProps extends VoidProps {
  readonly alt?: Attr<string>;
  readonly crossorigin?: Attr<CrossOrigin>;
  readonly decoding?: Attr<"sync" | "async" | "auto">;
  readonly fetchpriority?: Attr<"high" | "low" | "auto">;
  readonly height?: Attr<number | string>;
  readonly ismap?: Attr<boolean>;
  readonly loading?: Attr<"eager" | "lazy">;
  readonly referrerpolicy?: Attr<ReferrerPolicy>;
  readonly sizes?: Attr<string>;
  readonly src?: Attr<string>;
  readonly srcset?: Attr<string>;
  readonly usemap?: Attr<string>;
  readonly width?: Attr<number | string>;
}

export interface InputProps extends VoidProps, ControlProps {
  readonly accept?: Attr<string>;
  readonly alt?: Attr<string>;
  readonly autocomplete?: Attr<string>;
  readonly capture?: Attr<"user" | "environment">;
  readonly checked?: Attr<boolean>;
  readonly dirname?: Attr<string>;
  readonly formaction?: Attr<string>;
  readonly formenctype?: Attr<string>;
  readonly formmethod?: Attr<"get" | "post" | "dialog">;
  readonly formnovalidate?: Attr<boolean>;
  readonly formtarget?: Attr<string>;
  readonly height?: Attr<number | string>;
  readonly list?: Attr<string>;
  readonly max?: Attr<number | string>;
  readonly maxlength?: Attr<number>;
  readonly min?: Attr<number | string>;
  readonly minlength?: Attr<number>;
  readonly multiple?: Attr<boolean>;
  readonly pattern?: Attr<string>;
  readonly placeholder?: Attr<string>;
  readonly popovertarget?: Attr<string>;
  readonly readonly?: Attr<boolean>;
  readonly required?: Attr<boolean>;
  readonly size?: Attr<number>;
  readonly src?: Attr<string>;
  readonly step?: Attr<number | "any">;
  readonly type?: Attr<
    | "button"
    | "checkbox"
    | "color"
    | "date"
    | "datetime-local"
    | "email"
    | "file"
    | "hidden"
    | "image"
    | "month"
    | "number"
    | "password"
    | "radio"
    | "range"
    | "reset"
    | "search"
    | "submit"
    | "tel"
    | "text"
    | "time"
    | "url"
    | "week"
  >;
  readonly value?: Attr<string | number>;
  readonly width?: Attr<number | string>;
}

export interface LabelProps extends GlobalProps {
  readonly for?: Attr<string>;
}

export interface LiProps extends GlobalProps {
  readonly value?: Attr<number>;
}

export interface LinkProps extends VoidProps {
  readonly as?: Attr<string>;
  readonly crossorigin?: Attr<CrossOrigin>;
  readonly fetchpriority?: Attr<"high" | "low" | "auto">;
  readonly href?: Attr<string>;
  readonly hreflang?: Attr<string>;
  readonly integrity?: Attr<string>;
  readonly media?: Attr<string>;
  readonly referrerpolicy?: Attr<ReferrerPolicy>;
  readonly rel?: Attr<string>;
  readonly sizes?: Attr<string>;
  readonly type?: Attr<string>;
}

export interface MapProps extends GlobalProps {
  readonly name?: Attr<string>;
}

export interface MetaProps extends VoidProps {
  readonly charset?: Attr<string>;
  readonly content?: Attr<string>;
  readonly "http-equiv"?: Attr<string>;
  readonly media?: Attr<string>;
  readonly name?: Attr<string>;
}

export interface MeterProps extends GlobalProps {
  readonly high?: Attr<number>;
  readonly low?: Attr<number>;
  readonly max?: Attr<number>;
  readonly min?: Attr<number>;
  readonly optimum?: Attr<number>;
  readonly value?: Attr<number>;
}

export interface ObjectProps extends GlobalProps {
  readonly data?: Attr<string>;
  readonly form?: Attr<string>;
  readonly height?: Attr<number | string>;
  readonly name?: Attr<string>;
  readonly type?: Attr<string>;
  readonly width?: Attr<number | string>;
}

export interface OlProps extends GlobalProps {
  readonly reversed?: Attr<boolean>;
  readonly start?: Attr<number>;
  readonly type?: Attr<"1" | "a" | "A" | "i" | "I">;
}

export interface OptgroupProps extends GlobalProps {
  readonly disabled?: Attr<boolean>;
  readonly label?: Attr<string>;
}

export interface OptionProps extends GlobalProps {
  readonly disabled?: Attr<boolean>;
  readonly label?: Attr<string>;
  readonly selected?: Attr<boolean>;
  readonly value?: Attr<string | number>;
}

export interface OutputProps extends GlobalProps {
  readonly for?: Attr<string>;
  readonly form?: Attr<string>;
  readonly name?: Attr<string>;
}

export interface ProgressProps extends GlobalProps {
  readonly max?: Attr<number>;
  readonly value?: Attr<number>;
}

export interface ScriptProps extends GlobalProps {
  readonly async?: Attr<boolean>;
  readonly crossorigin?: Attr<CrossOrigin>;
  readonly defer?: Attr<boolean>;
  readonly fetchpriority?: Attr<"high" | "low" | "auto">;
  readonly integrity?: Attr<string>;
  readonly nomodule?: Attr<boolean>;
  readonly referrerpolicy?: Attr<ReferrerPolicy>;
  readonly src?: Attr<string>;
  readonly type?: Attr<string>;
}

export interface SelectProps extends GlobalProps, ControlProps {
  readonly autocomplete?: Attr<string>;
  readonly multiple?: Attr<boolean>;
  readonly required?: Attr<boolean>;
  readonly size?: Attr<number>;
  readonly value?: Attr<string | number>;
}

export interface SlotProps extends GlobalProps {
  readonly name?: Attr<string>;
}

export interface SourceProps extends VoidProps {
  readonly height?: Attr<number | string>;
  readonly media?: Attr<string>;
  readonly sizes?: Attr<string>;
  readonly src?: Attr<string>;
  readonly srcset?: Attr<string>;
  readonly type?: Attr<string>;
  readonly width?: Attr<number | string>;
}

export interface StyleProps extends GlobalProps {
  readonly media?: Attr<string>;
}

export interface CellProps extends GlobalProps {
  readonly colspan?: Attr<number>;
  readonly headers?: Attr<string>;
  readonly rowspan?: Attr<number>;
}

export interface ThProps extends CellProps {
  readonly abbr?: Attr<string>;
  readonly scope?: Attr<"row" | "col" | "rowgroup" | "colgroup">;
}

export interface TextareaProps extends GlobalProps, ControlProps {
  readonly autocomplete?: Attr<string>;
  readonly cols?: Attr<number>;
  readonly dirname?: Attr<string>;
  readonly maxlength?: Attr<number>;
  readonly minlength?: Attr<number>;
  readonly placeholder?: Attr<string>;
  readonly readonly?: Attr<boolean>;
  readonly required?: Attr<boolean>;
  readonly rows?: Attr<number>;
  /** The text the control holds; the DOM host writes it as the `value` property. */
  readonly value?: Attr<string>;
  readonly wrap?: Attr<"hard" | "soft" | "off">;
}

export interface TimeProps extends GlobalProps {
  readonly datetime?: Attr<string>;
}

export interface TrackProps extends VoidProps {
  readonly default?: Attr<boolean>;
  readonly kind?: Attr<"subtitles" | "captions" | "descriptions" | "chapters" | "metadata">;
  readonly label?: Attr<string>;
  readonly src?: Attr<string>;
  readonly srclang?: Attr<string>;
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

/** Every HTML tag a view may write. A tag not listed here does not compile. */
export interface HtmlElements {
  readonly a: AnchorProps;
  readonly abbr: GlobalProps;
  readonly address: GlobalProps;
  readonly area: AreaProps;
  readonly article: GlobalProps;
  readonly aside: GlobalProps;
  readonly audio: MediaProps;
  readonly b: GlobalProps;
  readonly base: BaseProps;
  readonly bdi: GlobalProps;
  readonly bdo: GlobalProps;
  readonly blockquote: QuoteProps;
  readonly body: GlobalProps;
  readonly br: VoidProps;
  readonly button: ButtonProps;
  readonly canvas: CanvasProps;
  readonly caption: GlobalProps;
  readonly cite: GlobalProps;
  readonly code: GlobalProps;
  readonly col: ColProps;
  readonly colgroup: ColgroupProps;
  readonly data: DataProps;
  readonly datalist: GlobalProps;
  readonly dd: GlobalProps;
  readonly del: EditProps;
  readonly details: DetailsProps;
  readonly dfn: GlobalProps;
  readonly dialog: DialogProps;
  readonly div: GlobalProps;
  readonly dl: GlobalProps;
  readonly dt: GlobalProps;
  readonly em: GlobalProps;
  readonly embed: EmbedProps;
  readonly fieldset: FieldsetProps;
  readonly figcaption: GlobalProps;
  readonly figure: GlobalProps;
  readonly footer: GlobalProps;
  readonly form: FormProps;
  readonly h1: GlobalProps;
  readonly h2: GlobalProps;
  readonly h3: GlobalProps;
  readonly h4: GlobalProps;
  readonly h5: GlobalProps;
  readonly h6: GlobalProps;
  readonly head: GlobalProps;
  readonly header: GlobalProps;
  readonly hgroup: GlobalProps;
  readonly hr: VoidProps;
  readonly html: HtmlProps;
  readonly i: GlobalProps;
  readonly iframe: IframeProps;
  readonly img: ImgProps;
  readonly input: InputProps;
  readonly ins: EditProps;
  readonly kbd: GlobalProps;
  readonly label: LabelProps;
  readonly legend: GlobalProps;
  readonly li: LiProps;
  readonly link: LinkProps;
  readonly main: GlobalProps;
  readonly map: MapProps;
  readonly mark: GlobalProps;
  readonly menu: GlobalProps;
  readonly meta: MetaProps;
  readonly meter: MeterProps;
  readonly nav: GlobalProps;
  readonly noscript: GlobalProps;
  readonly object: ObjectProps;
  readonly ol: OlProps;
  readonly optgroup: OptgroupProps;
  readonly option: OptionProps;
  readonly output: OutputProps;
  readonly p: GlobalProps;
  readonly picture: GlobalProps;
  readonly pre: GlobalProps;
  readonly progress: ProgressProps;
  readonly q: QuoteProps;
  readonly rp: GlobalProps;
  readonly rt: GlobalProps;
  readonly ruby: GlobalProps;
  readonly s: GlobalProps;
  readonly samp: GlobalProps;
  readonly script: ScriptProps;
  readonly search: GlobalProps;
  readonly section: GlobalProps;
  readonly select: SelectProps;
  readonly slot: SlotProps;
  readonly small: GlobalProps;
  readonly source: SourceProps;
  readonly span: GlobalProps;
  readonly strong: GlobalProps;
  readonly style: StyleProps;
  readonly sub: GlobalProps;
  readonly summary: GlobalProps;
  readonly sup: GlobalProps;
  readonly table: GlobalProps;
  readonly tbody: GlobalProps;
  readonly td: CellProps;
  readonly template: GlobalProps;
  readonly textarea: TextareaProps;
  readonly tfoot: GlobalProps;
  readonly th: ThProps;
  readonly thead: GlobalProps;
  readonly time: TimeProps;
  readonly title: GlobalProps;
  readonly tr: GlobalProps;
  readonly track: TrackProps;
  readonly u: GlobalProps;
  readonly ul: GlobalProps;
  readonly var: GlobalProps;
  readonly video: VideoProps;
  readonly wbr: VoidProps;
}
