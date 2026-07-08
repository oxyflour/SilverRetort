# General
- apps 下是独立可执行模块，packages 下是功能模块，保持 apps 下的逻辑简洁干净
- 每个文件尽量小于 500 行
- 写测试用例之前跟我确认

# 基础模块分工
- apps/desktop: electron 容器，启动后拉起 apps/next 和 apps/uvicorn
- apps/next: nodejs 后台服务，rewrite 到 python
- apps/uvicorn: python 后台服务
