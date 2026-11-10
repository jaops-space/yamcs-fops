package com.jaops.yamcs.fops;

import org.yamcs.http.HttpException;

import io.netty.handler.codec.http.HttpResponseStatus;

/** An HTTP error with any status (Yamcs has no exception for 409 Conflict). */
public class FopsException extends HttpException {
    private static final long serialVersionUID = 1L;
    private final HttpResponseStatus status;
    private final String type;

    public FopsException(HttpResponseStatus status, String type, String message) {
        super(message);
        this.status = status;
        this.type = type;
    }

    public static FopsException conflict(String message) {
        return new FopsException(HttpResponseStatus.CONFLICT, "ConflictException", message);
    }

    public static FopsException forbidden(String message) {
        return new FopsException(HttpResponseStatus.FORBIDDEN, "ForbiddenException", message);
    }

    public static FopsException badRequest(String message) {
        return new FopsException(HttpResponseStatus.BAD_REQUEST, "BadRequestException", message);
    }

    public static FopsException notFound(String message) {
        return new FopsException(HttpResponseStatus.NOT_FOUND, "NotFoundException", message);
    }

    public static FopsException unavailable(String message) {
        return new FopsException(HttpResponseStatus.SERVICE_UNAVAILABLE, "UnavailableException", message);
    }

    public String getType() {
        return type;
    }

    @Override
    public HttpResponseStatus getStatus() {
        return status;
    }
}
