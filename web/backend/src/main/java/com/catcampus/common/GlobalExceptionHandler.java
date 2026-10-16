package com.catcampus.common;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/** 全局异常处理：业务异常返回 200 + code=400，参数/系统异常同样收敛为 Result。
 *  ⚠️ 对外只给通用文案：e.getMessage() 常含内部细节
 *  （如 "rawPassword cannot be null"、Jackson 内部错误），直接回给客户端既误导用户又泄露实现。 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public Result<?> handleBiz(BizException e) {
        return Result.fail(e.getCode(), e.getMessage());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public Result<?> handleIllegalArg(IllegalArgumentException e) {
        log.warn("[catcampus] 参数错误：{}", e.getMessage());
        return Result.fail("参数格式错误");
    }

    /** 请求体不是合法 JSON / 类型不匹配（如 schoolId=abc） */
    @ExceptionHandler({ HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class })
    public Result<?> handleBadBody(Exception e) {
        log.warn("[catcampus] 请求体解析失败：{}", e.getMessage());
        return Result.fail("请求参数格式错误");
    }

    /** @Valid 校验失败 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public Result<?> handleValid(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + " " + f.getDefaultMessage())
                .reduce((a, b) -> a + "；" + b).orElse("参数校验失败");
        return Result.fail(msg);
    }

    @ExceptionHandler(Exception.class)
    public Result<?> handleOther(Exception e) {
        log.error("[catcampus] 系统异常", e);
        return Result.fail(500, "服务异常，请稍后重试");
    }
}
