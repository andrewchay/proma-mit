# Executor 运行边界

每个请求使用非特权 bubblewrap 创建独立 user / mount / PID / network namespace，通过固定的目录文件描述符（--bind-fd）仅挂载当前 workspace，避免验证后以可替换路径重新绑定。系统运行库只读，/tmp 私有，/proc 留空；没有宿主环境变量、/app 或其他 workspace。工作负载本身可以运行任意允许的解释器代码，命令 allowlist 不是文件隔离边界。

GitHub 托管 runner 可能因其容器安全策略拒绝容器内创建 Linux namespace。质量工作流会先探测该能力：不可用时仍运行请求边界和沙箱参数契约测试，并以警告标明实际隔离与取消验收必须在支持内层 namespace 的 Linux runner 上运行；这类跳过不代表沙箱已经在该 runner 验证通过。

Compose 保留非 root、cap_drop ALL、no-new-privileges、只读根目录、CPU / 内存 / PID / 输出 / 时间限制。单个 worker 串行接受任务，忙时返回 429。网络默认禁用；需要网络的业务工具应由受控服务提供。

seccomp.json 来源于 Moby profiles 默认拒绝策略（commit 61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31），仅额外允许 unshare、mount、umount2、pivot_root、sethostname，以及带 CLONE_NEWUSER 的 clone。挂载能力仅存在于内层新建用户 namespace；容器没有 CAP_SYS_ADMIN。没有使用 privileged 或 seccomp=unconfined。Docker / 宿主 LSM 若仍阻止用户 namespace，执行会失败，不允许退回宿主命令。

来源：[Moby 默认策略](https://github.com/moby/profiles/blob/61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31/seccomp/default.json)，遵循其 Apache-2.0 许可；[Docker seccomp 说明](https://docs.docker.com/engine/security/seccomp/)。
依赖：Alpine 3.23、bubblewrap 0.12.0-r0、Bun 1.3.14；libstdc++ 为 Bun 的动态运行依赖。

验收命令：

```sh
docker build -f apps/executor/Dockerfile -t gravitas-executor-test .
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --security-opt seccomp=apps/executor/seccomp.json --pids-limit 128 --memory 1g --cpus 1 gravitas-executor-test bun test src
```

部署到不同内核、Docker 或 AppArmor 配置时必须重复这些测试。任务目录的授权归属由 server 建立，executor 只信任认证后的 server 请求；token 不向任务进程传递。
