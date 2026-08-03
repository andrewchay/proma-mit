#!/usr/bin/env swift
/**
 * read-calendar.swift - macOS EventKit 日历读取脚本
 *
 * 用法: swift read-calendar.swift <daysBack> <daysForward>
 * 输出: JSON 格式的事件数组
 */

import Foundation
import EventKit

// MARK: - 参数解析
let args = CommandLine.arguments
let daysBack = args.count > 1 ? Int(args[1]) ?? 30 : 30
let daysForward = args.count > 2 ? Int(args[2]) ?? 90 : 90

// MARK: - EventStore
let eventStore = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)

// 日期范围
let now = Date()
let calendar = Calendar.current
let startDate = calendar.date(byAdding: .day, value: -daysBack, to: now)!
let endDate = calendar.date(byAdding: .day, value: daysForward, to: now)!

// ISO8601 格式化器
let isoFormatter = ISO8601DateFormatter()
isoFormatter.formatOptions = [.withInternetDateTime]

// MARK: - 权限请求与读取
var outputEvents: [[String: Any]] = []
var outputError: String?

func readCalendars() {
    // 获取所有日历
    let calendars = eventStore.calendars(for: .event)
    
    // 创建谓词
    let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
    let events = eventStore.events(matching: predicate)
    
    for event in events {
        var dict: [String: Any] = [
            "id": event.calendarItemIdentifier,
            "title": event.title ?? "(无标题)",
            "startTime": isoFormatter.string(from: event.startDate),
            "endTime": isoFormatter.string(from: event.endDate),
            "allDay": event.isAllDay,
            "calendarName": event.calendar?.title ?? "默认",
            "isRecurring": event.hasRecurrenceRules,
        ]
        
        if let location = event.location, !location.isEmpty {
            dict["location"] = location
        }
        
        if let notes = event.notes, !notes.isEmpty {
            dict["notes"] = notes
        }
        
        // 颜色提取已移除（命令行 Swift 中 NSColor 初始化器不可用）
        // calendarColor 为可选字段，不影响核心功能
        
        outputEvents.append(dict)
    }
}

// macOS 14+ 使用新的权限 API
if #available(macOS 14.0, *) {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess:
        readCalendars()
        semaphore.signal()
    case .writeOnly:
        outputError = "日历权限为仅写入，需要完全访问权限"
        semaphore.signal()
    case .denied:
        outputError = "日历权限被拒绝，请在系统设置中允许访问"
        semaphore.signal()
    case .notDetermined:
        eventStore.requestFullAccessToEvents { granted, error in
            if granted {
                readCalendars()
            } else {
                outputError = error?.localizedDescription ?? "日历权限请求被拒绝"
            }
            semaphore.signal()
        }
    case .restricted:
        outputError = "日历访问受限"
        semaphore.signal()
    @unknown default:
        outputError = "未知的日历权限状态"
        semaphore.signal()
    }
} else {
    // macOS 13 及以下
    let status = EKEventStore.authorizationStatus(for: .event)
    switch status {
    case .authorized:
        readCalendars()
        semaphore.signal()
    case .denied:
        outputError = "日历权限被拒绝"
        semaphore.signal()
    case .notDetermined:
        eventStore.requestAccess(to: .event) { granted, error in
            if granted {
                readCalendars()
            } else {
                outputError = error?.localizedDescription ?? "日历权限请求被拒绝"
            }
            semaphore.signal()
        }
    case .restricted:
        outputError = "日历访问受限"
        semaphore.signal()
    default:
        // 处理较新 SDK 中可能新增的 case（如 .fullAccess, .writeOnly）
        if status.rawValue == 3 { // fullAccess
            readCalendars()
        } else {
            outputError = "未知的日历权限状态 (rawValue: \(status.rawValue))"
        }
        semaphore.signal()
    }
}

semaphore.wait()

// MARK: - 输出
if let error = outputError {
    // 输出到 stderr
    FileHandle.standardError.write(Data("error: \(error)".utf8))
    exit(1)
} else {
    // 输出 JSON 到 stdout
    do {
        let jsonData = try JSONSerialization.data(withJSONObject: outputEvents, options: [.sortedKeys])
        if let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
        }
    } catch {
        FileHandle.standardError.write(Data("error: JSON 序列化失败: \(error)".utf8))
        exit(1)
    }
}
