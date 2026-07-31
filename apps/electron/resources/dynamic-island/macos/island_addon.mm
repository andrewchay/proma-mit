// macOS 灵动岛通知原生模块（N-API / ObjC / AppKit）
//
// 职责：只管「画」——创建 NSPanel 浮层、贴合刘海、渲染通知内容。
// 业务（队列/计时/配置）由 JS 主进程负责。
//
// 协议（与 JS 渲染子进程之间，JSON + 换行按行传输）：
//   stdin  <-  { "type": "render", "view": {...} }  / { "type": "clear" }
//   stdout ->  { "type": "clicked", "id": "..." }   / { "type": "log", "level": "...", "msg": "..." }
//
// 编译：xcrun clang++ -fobjc-arc -dynamiclib -undefined dynamic_lookup 配合 N-API 头文件。
// 参考 apps/electron/scripts/build-computer-use-helper.ts 的构建管线。

#define NAPI_VERSION 8
#include <node_api.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

// ============================================================================
// 全局状态
// ============================================================================

static NSPanel *gPanel = nil;
static NSTextField *gTitleLabel = nil;
static NSTextField *gBodyLabel = nil;
static NSImageView *gIconView = nil;
static NSTextField *gBadgeLabel = nil;
static NSColor *gAccentColor = [NSColor colorWithSRGBRed:0.04 green:0.42 blue:1.0 alpha:1.0]; // #0a84ff
static NSString *gCurrentId = @"";
static BOOL gClickable = NO;
static BOOL gShown = NO;
static CGFloat gWindowWidth = 260;
static CGFloat gWindowHeight = 40;

// ============================================================================
// stdout 事件（JSON + 换行）
// ============================================================================

static void EmitLog(NSString *level, NSString *msg) {
  if (msg.length == 0) return;
  NSDictionary *event = @{ @"type": @"log", @"level": level, @"msg": msg };
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!data) return;
  NSFileHandle *out = [NSFileHandle fileHandleWithStandardOutput];
  [out writeData:data];
  [out writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

static void EmitClicked(NSString *identifier) {
  NSDictionary *event = @{ @"type": @"clicked", @"id": identifier ?: @"" };
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!data) return;
  NSFileHandle *out = [NSFileHandle fileHandleWithStandardOutput];
  [out writeData:data];
  [out writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

// ============================================================================
// 颜色与图标
// ============================================================================

static NSColor *AccentForLevel(NSString *level) {
  if ([level isEqualToString:@"success"]) return [NSColor colorWithSRGBRed:0.19 green:0.82 blue:0.35 alpha:1.0]; // #30d158
  if ([level isEqualToString:@"warning"]) return [NSColor colorWithSRGBRed:1.0 green:0.62 blue:0.04 alpha:1.0];   // #ff9f0a
  if ([level isEqualToString:@"error"]) return [NSColor colorWithSRGBRed:1.0 green:0.27 blue:0.23 alpha:1.0];     // #ff453a
  if ([level isEqualToString:@"progress"]) return [NSColor colorWithSRGBRed:0.39 green:0.82 blue:1.0 alpha:1.0];  // #64d2ff
  return [NSColor colorWithSRGBRed:0.04 green:0.42 blue:1.0 alpha:1.0];                                            // #0a84ff info
}

static NSString *SymbolForLevel(NSString *level) {
  if ([level isEqualToString:@"success"]) return @"checkmark.circle.fill";
  if ([level isEqualToString:@"warning"]) return @"exclamationmark.triangle.fill";
  if ([level isEqualToString:@"error"]) return @"xmark.octagon.fill";
  if ([level isEqualToString:@"progress"]) return @"arrow.triangle.2.circlepath";
  return @"info.circle.fill";
}

// ============================================================================
// 可点击视图：接收 mouseUp 后回发 clicked 事件
// ============================================================================

@interface NotchClickableView : NSView
@property (nonatomic, copy) void (^onClick)(void);
@end

@implementation NotchClickableView
- (void)mouseUp:(NSEvent *)event {
  (void)event;
  if (self.onClick) self.onClick();
}
@end

// 非激活面板：永不成为 key window，不抢焦点
@interface NotchPanel : NSPanel
@end

@implementation NotchPanel
- (BOOL)canBecomeKey { return NO; }
- (BOOL)canBecomeMain { return NO; }
@end

// ============================================================================
// 刘海定位
// ============================================================================

// 判断当前主屏是否有刘海/圆角（safeAreaInsets.top > 1 视为有顶部安全区凹陷）
static BOOL HasNotch(void) {
  NSScreen *screen = [NSScreen mainScreen];
  if (!screen) return NO;
  if (@available(macOS 12.0, *)) {
    return screen.safeAreaInsets.top > 1;
  }
  return NO;
}

// 计算窗口 frame：贴 visibleFrame 顶部居中（菜单栏下方），有刘海时贴合刘海下方
static NSRect NotchFrame(void) {
  NSScreen *screen = [NSScreen mainScreen] ?: [NSScreen screens].firstObject;
  NSRect visible = screen ? screen.visibleFrame : NSMakeRect(0, 0, 1280, 720);
  CGFloat top = NSMaxY(visible);
  CGFloat width = gWindowWidth;
  CGFloat height = gWindowHeight;
  CGFloat x = NSMidX(visible) - width / 2.0;
  // 有刘海时让窗口更贴近刘海（刘海下方 2pt），无刘海则贴顶
  CGFloat y = top - height - (HasNotch() ? -2 : 0);
  return NSMakeRect(round(x), round(y), width, height);
}

// ============================================================================
// UI 构建
// ============================================================================

static NSTextField *MakeLabel(CGFloat fontSize, BOOL bold) {
  NSTextField *label = [[NSTextField alloc] initWithFrame:NSZeroRect];
  label.editable = NO;
  label.selectable = NO;
  label.bezeled = NO;
  label.drawsBackground = NO;
  label.textColor = [NSColor whiteColor];
  label.font = bold
    ? [NSFont systemFontOfSize:fontSize weight:NSFontWeightSemibold]
    : [NSFont systemFontOfSize:fontSize weight:NSFontWeightRegular];
  label.lineBreakMode = NSLineBreakByTruncatingTail;
  return label;
}

static void BuildPanel(void) {
  if (gPanel) return;

  NSRect frame = NotchFrame();
  gPanel = [[NotchPanel alloc] initWithContentRect:frame
                                          styleMask:NSWindowStyleMaskBorderless
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
  gPanel.level = NSStatusWindowLevel + 1;
  gPanel.hasShadow = YES;
  gPanel.opaque = NO;
  gPanel.backgroundColor = [NSColor clearColor];
  gPanel.hidesOnDeactivate = NO;
  gPanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  gPanel.movableByWindowBackground = NO;
  // 默认鼠标穿透：只有可点击通知（render 时设置 clickable=true）才接收点击
  gPanel.ignoresMouseEvents = YES;

  NSView *root = [gPanel contentView];
  root.wantsLayer = YES;
  // 胶囊形：圆角 = 高度的一半，视觉上与灵动岛一致
  root.layer.cornerRadius = gWindowHeight / 2.0;
  root.layer.masksToBounds = YES;
  root.layer.backgroundColor = [[NSColor colorWithSRGBRed:0.05 green:0.05 blue:0.06 alpha:0.94] CGColor];

  NotchClickableView *clickable = [[NotchClickableView alloc] initWithFrame:root.bounds];
  clickable.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  __weak NotchClickableView *weakClickable = clickable;
  clickable.onClick = ^{
    (void)weakClickable;
    if (gClickable && gCurrentId.length > 0) {
      EmitClicked(gCurrentId);
    }
  };
  [root addSubview:clickable];

  // ===== 内容居中布局（左右上下都居中） =====
  // 用一个 StackView 承载「图标 + 标题」，整体在窗口中水平垂直居中；
  // 排队徽标仍固定在右侧，避免挤压标题。
  gIconView = [[NSImageView alloc] initWithFrame:NSMakeRect(0, 0, 18, 18)];
  gIconView.imageScaling = NSImageScaleProportionallyUpOrDown;

  gTitleLabel = MakeLabel(13, YES);
  gTitleLabel.cell.usesSingleLineMode = YES;
  gTitleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
  // 标题最大宽度：整体留出右侧徽标空间
  [gTitleLabel setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];

  NSStackView *centerStack = [[NSStackView alloc] init];
  centerStack.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  centerStack.alignment = NSLayoutAttributeCenterY;
  centerStack.spacing = 7;
  [centerStack addArrangedSubview:gIconView];
  [centerStack addArrangedSubview:gTitleLabel];
  centerStack.translatesAutoresizingMaskIntoConstraints = NO;
  [clickable addSubview:centerStack];

  [NSLayoutConstraint activateConstraints:@[
    // 整体水平垂直居中；有排队徽标时徽标固定右侧、标题自动让位（StackView 压缩优先级）
    [centerStack.centerXAnchor constraintEqualToAnchor:clickable.centerXAnchor],
    [centerStack.centerYAnchor constraintEqualToAnchor:clickable.centerYAnchor],
    [centerStack.widthAnchor constraintLessThanOrEqualToConstant:frame.size.width - 64],
  ]];

  // 正文：紧凑模式下不再单独占行（保留引用供未来扩展）
  gBodyLabel = MakeLabel(11.5, NO);
  gBodyLabel.textColor = [NSColor colorWithWhite:0.78 alpha:1.0];
  gBodyLabel.hidden = YES;
  [clickable addSubview:gBodyLabel];

  // 排队徽标：右侧垂直居中
  gBadgeLabel = MakeLabel(10, YES);
  gBadgeLabel.textColor = [NSColor colorWithWhite:0.92 alpha:1.0];
  gBadgeLabel.alignment = NSTextAlignmentCenter;
  gBadgeLabel.frame = NSMakeRect(frame.size.width - 40, (gWindowHeight - 20) / 2.0, 28, 20);
  gBadgeLabel.layer.cornerRadius = 10;
  gBadgeLabel.layer.masksToBounds = YES;
  gBadgeLabel.layer.backgroundColor = [[NSColor colorWithWhite:0.2 alpha:0.9] CGColor];
  gBadgeLabel.hidden = YES;
  [clickable addSubview:gBadgeLabel];

  [gPanel setFrame:frame display:NO];
}

// ============================================================================
// render / clear
// ============================================================================

static void ApplyView(NSDictionary *view) {
  dispatch_async(dispatch_get_main_queue(), ^{
    BuildPanel();
    if (!gPanel) return;

    NSString *identifier = view[@"id"];
    NSString *title = view[@"title"];
    NSString *body = view[@"body"];
    NSString *level = view[@"level"] ?: @"info";
    NSNumber *clickable = view[@"clickable"];
    NSNumber *queued = view[@"queued"];
    NSString *accentHex = view[@"accent"];

    gCurrentId = identifier ?: @"";
    gClickable = [clickable boolValue];

    // 不可点击的通知让鼠标事件穿透（不拦截下方应用），可点击才接收点击回传
    gPanel.ignoresMouseEvents = !gClickable;

    // 紧凑单行：标题为主；有正文时以「标题 · 正文」追加（正文截断）
    NSString *rawTitle = title ?: @"";
    NSString *rawBody = body ?: @"";
    if (rawBody.length > 0) {
      gTitleLabel.stringValue = [NSString stringWithFormat:@"%@ · %@", rawTitle, rawBody];
    } else {
      gTitleLabel.stringValue = rawTitle;
    }
    gBodyLabel.stringValue = @"";

    NSString *symbol = view[@"symbol"] ?: SymbolForLevel(level);
    NSImage *image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:@"通知"];
    if (image) {
      NSImage *config = [image imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:14 weight:NSFontWeightMedium]];
      gIconView.image = config;
    }
    gIconView.contentTintColor = AccentForLevel(level);

    if (accentHex.length > 0) {
      gAccentColor = [NSColor colorWithSRGBRed:0.04 green:0.42 blue:1.0 alpha:1.0];
    }

    NSUInteger queuedCount = queued ? [queued unsignedIntegerValue] : 0;
    if (queuedCount > 0) {
      gBadgeLabel.hidden = NO;
      gBadgeLabel.stringValue = [NSString stringWithFormat:@"+%lu", (unsigned long)queuedCount];
    } else {
      gBadgeLabel.hidden = YES;
    }

    // 每次 render 重新贴合刘海（显示器/分辨率可能变化）
    NSRect frame = NotchFrame();
    [gPanel setFrame:frame display:YES];

    if (!gShown) {
      [gPanel orderFrontRegardless];
      gShown = YES;
      EmitLog(@"info", [NSString stringWithFormat:@"window shown: %@", gCurrentId ?: @"?"]);
    } else {
      EmitLog(@"info", [NSString stringWithFormat:@"window updated: %@", gCurrentId ?: @"?"]);
    }
  });
}

static void ClearView(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    gShown = NO;
    gCurrentId = @"";
    gClickable = NO;
    [gPanel orderOut:nil];
  });
}

// ============================================================================
// stdin 解析（行缓冲，JSON + 换行）
// ============================================================================

static void HandleStdinChunk(NSData *data, NSMutableString *buffer) {
  if (data.length == 0) {
    // EOF → 退出
    EmitLog(@"info", @"stdin EOF, exiting");
    exit(0);
  }
  NSString *chunk = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!chunk) return;
  [buffer appendString:chunk];

  NSRange newline;
  while ((newline = [buffer rangeOfString:@"\n"]).location != NSNotFound) {
    NSString *line = [[buffer substringToIndex:newline.location] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    [buffer deleteCharactersInRange:NSMakeRange(0, newline.location + 1)];
    if (line.length == 0) continue;

    NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
    id obj = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
    if (![obj isKindOfClass:[NSDictionary class]]) continue;

    NSDictionary *cmd = (NSDictionary *)obj;
    NSString *type = cmd[@"type"];
    if ([type isEqualToString:@"render"]) {
      NSDictionary *view = cmd[@"view"];
      if ([view isKindOfClass:[NSDictionary class]]) {
        ApplyView(view);
      }
    } else if ([type isEqualToString:@"clear"]) {
      ClearView();
    } else {
      EmitLog(@"warn", [NSString stringWithFormat:@"unknown command: %@", type ?: @"?"]);
    }
  }
}

static void StartStdinLoop(void) {
  static NSMutableString *buffer = nil;
  if (!buffer) buffer = [[NSMutableString alloc] init];

  // 用 GCD dispatch source 读 stdin：不依赖 NSRunLoop（fork 子进程在 ELECTRON_RUN_AS_NODE
  // 下主 runloop 行为不可控），确保 render/clear 命令一定能收到。
  dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_global_queue(0, 0));
  if (!source) {
    EmitLog(@"error", @"failed to create stdin source");
    return;
  }
  dispatch_source_set_event_handler(source, ^{
    char raw[4096];
    ssize_t n = read(STDIN_FILENO, raw, sizeof(raw));
    if (n > 0) {
      NSData *data = [NSData dataWithBytes:raw length:(NSUInteger)n];
      dispatch_async(dispatch_get_main_queue(), ^{
        HandleStdinChunk(data, buffer);
      });
    } else if (n == 0) {
      // EOF
      dispatch_async(dispatch_get_main_queue(), ^{
        EmitLog(@"info", @"stdin EOF, exiting");
        exit(0);
      });
      dispatch_source_cancel(source);
    }
  });
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_source_cancel(source);
  });
  dispatch_resume(source);
}

// ============================================================================
// N-API 导出
// ============================================================================

static napi_value NativeStart(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  if (argc >= 1) {
    napi_value opts = args[0];
    napi_valuetype type;
    napi_typeof(env, opts, &type);
    if (type == napi_object) {
      napi_value widthValue, heightValue;
      double width = 260, height = 40;
      if (napi_get_named_property(env, opts, "width", &widthValue) == napi_ok) {
        napi_get_value_double(env, widthValue, &width);
      }
      if (napi_get_named_property(env, opts, "height", &heightValue) == napi_ok) {
        napi_get_value_double(env, heightValue, &height);
      }
      gWindowWidth = width;
      gWindowHeight = height;
    }
  }

  // 主线程启动 NSApplication（必须先初始化，再创建窗口，最后进入事件循环）：
  // fork.js 的 JS 层在 native.start() 后不再需要响应任何事，
  // stdin 由 dispatch source 在后台队列读取，UI 更新 dispatch 回 main queue
  // 由这里启动的 AppKit runloop drain。
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp finishLaunching];

  BuildPanel();
  StartStdinLoop();
  EmitLog(@"info", [NSString stringWithFormat:@"island native started (%.0fx%.0f)", gWindowWidth, gWindowHeight]);

  [NSApp run];

  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, NativeStart, NULL, &fn);
  napi_set_named_property(env, exports, "start", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
