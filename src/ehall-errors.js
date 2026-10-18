export class EhallError extends Error {}

export class EhallLoginRequired extends Error {
  constructor() { super('ehall 尚未登录或登录已失效。请发送「ehall 登录」，在这台电脑弹出的独立窗口中手动登录，再发送「ehall 登录完成」。密码和验证码不要发到飞书。'); }
}
