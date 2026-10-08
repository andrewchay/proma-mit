import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ControlledTaskStartButton } from './ControlledTaskStartButton'

test('Given 待启动任务 When 首次渲染 Then 仅出现预检入口而不自动确认或调用模型', () => {
	let changed = 0
	const html = renderToStaticMarkup(
		<ControlledTaskStartButton
			taskId="fixture-task"
			revision={1}
			onChanged={() => {
				changed++
			}}
		/>,
	)
	expect(html).toContain('预检并开始')
	expect(html).not.toContain('确认开始（可能收费）')
	expect(html).toContain('controlled-task-start')
	expect(changed).toBe(0)
})
