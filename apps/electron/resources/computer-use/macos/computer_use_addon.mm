#define NAPI_VERSION 8
#include <node_api.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static napi_value NativeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}
static napi_value Throw(napi_env env, const char *message);

static napi_value Status(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "accessibility", NativeBoolean(env, AXIsProcessTrusted()));
  napi_set_named_property(env, result, "screenRecording", NativeBoolean(env, CGPreflightScreenCaptureAccess()));
  return result;
}

static napi_value RequestPermissions(napi_env env, napi_callback_info info) {
  NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
  AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  CGRequestScreenCaptureAccess();
  return Status(env, info);
}

static napi_value FrontmostApplication(napi_env env, napi_callback_info info) {
  NSRunningApplication *application = [[NSWorkspace sharedWorkspace] frontmostApplication];
  napi_value result; napi_create_object(env, &result);
  NSString *name = application.localizedName ?: @"";
  NSString *bundleId = application.bundleIdentifier ?: @"";
  napi_value nameValue, bundleValue, pidValue;
  napi_create_string_utf8(env, name.UTF8String, NAPI_AUTO_LENGTH, &nameValue);
  napi_create_string_utf8(env, bundleId.UTF8String, NAPI_AUTO_LENGTH, &bundleValue);
  napi_create_int32(env, application.processIdentifier, &pidValue);
  napi_set_named_property(env, result, "name", nameValue);
  napi_set_named_property(env, result, "bundleId", bundleValue);
  napi_set_named_property(env, result, "pid", pidValue);
  return result;
}

static napi_value FrontmostWindow(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  NSRunningApplication *application = [[NSWorkspace sharedWorkspace] frontmostApplication];
  AXUIElementRef appElement = AXUIElementCreateApplication(application.processIdentifier); AXUIElementRef window = NULL;
  AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute, (CFTypeRef *)&window);
  if (!window) { CFRelease(appElement); return Throw(env, "当前前台应用没有可读取的聚焦窗口"); }
  CFTypeRef titleValue = NULL; AXUIElementCopyAttributeValue(window, kAXTitleAttribute, &titleValue); NSString *title = titleValue ? (__bridge NSString *)titleValue : @"";
  CFTypeRef positionValue = NULL, sizeValue = NULL; AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &positionValue); AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &sizeValue); CGPoint position = CGPointZero; CGSize size = CGSizeZero; if (positionValue) AXValueGetValue((AXValueRef)positionValue, (AXValueType)kAXValueCGPointType, &position); if (sizeValue) AXValueGetValue((AXValueRef)sizeValue, (AXValueType)kAXValueCGSizeType, &size);
  napi_value result, value; napi_create_object(env, &result); napi_create_string_utf8(env, title.UTF8String, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "title", value); napi_create_double(env, position.x, &value); napi_set_named_property(env, result, "x", value); napi_create_double(env, position.y, &value); napi_set_named_property(env, result, "y", value); napi_create_double(env, size.width, &value); napi_set_named_property(env, result, "width", value); napi_create_double(env, size.height, &value); napi_set_named_property(env, result, "height", value); if (titleValue) CFRelease(titleValue); if (positionValue) CFRelease(positionValue); if (sizeValue) CFRelease(sizeValue); CFRelease(window); CFRelease(appElement); return result;
}

static bool ReadNumber(napi_env env, napi_value object, const char *name, double *value) {
  napi_value raw;
  bool present = false;
  napi_has_named_property(env, object, name, &present);
  if (!present) return false;
  napi_get_named_property(env, object, name, &raw);
  napi_valuetype type;
  napi_typeof(env, raw, &type);
  if (type != napi_number) return false;
  napi_get_value_double(env, raw, value);
  // 全局显示器坐标可以为负数（例如主屏左侧或上方的副屏）。
  return isfinite(*value) && fabs(*value) <= 100000;
}

static bool ReadUnsignedNumber(napi_env env, napi_value object, const char *name, double *value) {
  return ReadNumber(env, object, name, value) && *value >= 0;
}

static bool ReadString(napi_env env, napi_value object, const char *name, NSString **value) {
  napi_value raw;
  bool present = false;
  napi_has_named_property(env, object, name, &present);
  if (!present) return false;
  napi_get_named_property(env, object, name, &raw);
  napi_valuetype type;
  napi_typeof(env, raw, &type);
  if (type != napi_string) return false;
  size_t length = 0;
  napi_get_value_string_utf8(env, raw, NULL, 0, &length);
  NSMutableData *data = [NSMutableData dataWithLength:length + 1];
  napi_get_value_string_utf8(env, raw, static_cast<char *>(data.mutableBytes), length + 1, &length);
  *value = [[NSString alloc] initWithUTF8String:static_cast<const char *>(data.bytes)];
  return *value != nil;
}

static bool FirstArgument(napi_env env, napi_callback_info info, napi_value *argument) {
  size_t count = 1;
  napi_get_cb_info(env, info, &count, argument, NULL, NULL);
  napi_valuetype type;
  return count == 1 && napi_typeof(env, argument[0], &type) == napi_ok && type == napi_object;
}

static napi_value Throw(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value Click(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  napi_value arguments[1];
  double x = 0, y = 0;
  if (!FirstArgument(env, info, arguments) || !ReadNumber(env, arguments[0], "x", &x) || !ReadNumber(env, arguments[0], "y", &y)) return Throw(env, "x 和 y 必须是有效的屏幕坐标");
  CGPoint point = CGPointMake(x, y);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  if (down == NULL || up == NULL) return Throw(env, "无法创建鼠标事件");
  CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
  CFRelease(down); CFRelease(up);
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Move(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  napi_value arguments[1]; double x = 0, y = 0;
  if (!FirstArgument(env, info, arguments) || !ReadNumber(env, arguments[0], "x", &x) || !ReadNumber(env, arguments[0], "y", &y)) return Throw(env, "x 和 y 必须是有效的屏幕坐标");
  CGEventRef event = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(x, y), kCGMouseButtonLeft);
  if (event == NULL) return Throw(env, "无法创建鼠标移动事件");
  CGEventPost(kCGHIDEventTap, event); CFRelease(event); napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value DoubleClick(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  napi_value arguments[1]; double x = 0, y = 0;
  if (!FirstArgument(env, info, arguments) || !ReadNumber(env, arguments[0], "x", &x) || !ReadNumber(env, arguments[0], "y", &y)) return Throw(env, "x 和 y 必须是有效的屏幕坐标");
  CGPoint point = CGPointMake(x, y);
  for (int count = 1; count <= 2; count++) { CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft); CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft); if (!down || !up) return Throw(env, "无法创建鼠标事件"); CGEventSetIntegerValueField(down, kCGMouseEventClickState, count); CGEventSetIntegerValueField(up, kCGMouseEventClickState, count); CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up); CFRelease(down); CFRelease(up); }
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Drag(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  napi_value arguments[1]; double fromX = 0, fromY = 0, toX = 0, toY = 0;
  if (!FirstArgument(env, info, arguments) || !ReadNumber(env, arguments[0], "fromX", &fromX) || !ReadNumber(env, arguments[0], "fromY", &fromY) || !ReadNumber(env, arguments[0], "toX", &toX) || !ReadNumber(env, arguments[0], "toY", &toY)) return Throw(env, "拖拽坐标无效");
  CGPoint from = CGPointMake(fromX, fromY), to = CGPointMake(toX, toY);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, from, kCGMouseButtonLeft); CGEventRef drag = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, to, kCGMouseButtonLeft); CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, to, kCGMouseButtonLeft);
  if (!down || !drag || !up) return Throw(env, "无法创建拖拽事件"); CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, drag); CGEventPost(kCGHIDEventTap, up); CFRelease(down); CFRelease(drag); CFRelease(up); napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value KeyCombo(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  napi_value arguments[1]; double keyCode = 0, modifiers = 0;
  const uint64_t allowedModifiers = kCGEventFlagMaskCommand | kCGEventFlagMaskShift | kCGEventFlagMaskAlternate | kCGEventFlagMaskControl;
  if (!FirstArgument(env, info, arguments) || !ReadUnsignedNumber(env, arguments[0], "keyCode", &keyCode) || !ReadUnsignedNumber(env, arguments[0], "modifiers", &modifiers) || keyCode > 255 || ((uint64_t)modifiers & ~allowedModifiers) != 0) return Throw(env, "快捷键参数无效");
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keyCode, true); CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keyCode, false); if (!down || !up) return Throw(env, "无法创建键盘事件"); CGEventSetFlags(down, (CGEventFlags)modifiers); CGEventSetFlags(up, (CGEventFlags)modifiers); CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up); CFRelease(down); CFRelease(up); napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Type(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  napi_value arguments[1]; NSString *text = nil;
  if (!FirstArgument(env, info, arguments) || !ReadString(env, arguments[0], "text", &text) || text.length == 0 || text.length > 10000) return Throw(env, "text 必须是长度不超过 10000 的非空字符串");
  UniChar *characters = static_cast<UniChar *>(calloc(text.length, sizeof(UniChar)));
  [text getCharacters:characters range:NSMakeRange(0, text.length)];
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true); CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
  if (down == NULL || up == NULL) { free(characters); return Throw(env, "无法创建键盘事件"); }
  CGEventKeyboardSetUnicodeString(down, (UniCharCount)text.length, characters); CGEventKeyboardSetUnicodeString(up, (UniCharCount)text.length, characters);
  CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
  free(characters); CFRelease(down); CFRelease(up);
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Scroll(napi_env env, napi_callback_info info) {
  if (!AXIsProcessTrusted()) return Throw(env, "需要在 macOS 系统设置中允许 Proma 使用辅助功能");
  napi_value arguments[1]; NSString *direction = nil; double amount = 700;
  if (!FirstArgument(env, info, arguments) || !ReadString(env, arguments[0], "direction", &direction) || (![direction isEqualToString:@"up"] && ![direction isEqualToString:@"down"])) return Throw(env, "direction 必须为 up 或 down");
  napi_value raw; bool present = false; napi_has_named_property(env, arguments[0], "amount", &present);
  if (present && (!ReadNumber(env, arguments[0], "amount", &amount) || amount < 1 || amount > 2000)) return Throw(env, "amount 必须为 1 到 2000 的数字");
  int32_t delta = [direction isEqualToString:@"up"] ? (int32_t)amount : -(int32_t)amount;
  CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 1, delta);
  if (event == NULL) return Throw(env, "无法创建滚动事件");
  CGEventPost(kCGHIDEventTap, event); CFRelease(event);
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "status", NULL, Status, NULL, NULL, NULL, napi_default, NULL },
    { "requestPermissions", NULL, RequestPermissions, NULL, NULL, NULL, napi_default, NULL },
    { "frontmostApplication", NULL, FrontmostApplication, NULL, NULL, NULL, napi_default, NULL },
    { "frontmostWindow", NULL, FrontmostWindow, NULL, NULL, NULL, napi_default, NULL },
    { "click", NULL, Click, NULL, NULL, NULL, napi_default, NULL },
    { "move", NULL, Move, NULL, NULL, NULL, napi_default, NULL },
    { "doubleClick", NULL, DoubleClick, NULL, NULL, NULL, napi_default, NULL },
    { "drag", NULL, Drag, NULL, NULL, NULL, napi_default, NULL },
    { "keyCombo", NULL, KeyCombo, NULL, NULL, NULL, napi_default, NULL },
    { "type", NULL, Type, NULL, NULL, NULL, napi_default, NULL },
    { "scroll", NULL, Scroll, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
