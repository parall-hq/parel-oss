import type {
	ChannelConnector,
	ChannelDelivery,
	ConnectorContext,
	ConnectorEffect,
	ConnectRequest,
	WebSocketFrame,
} from "@parel/plugin-sdk";
import { openSlackSocketModeConnection } from "./connect.js";
import { buildSlackDeliveryEffect } from "./delivery.js";
import { handleSlackSocketMessage } from "./socket.js";

const connector: ChannelConnector = {
	async connect(ctx: ConnectorContext): Promise<ConnectRequest> {
		return openSlackSocketModeConnection(ctx);
	},

	async onMessage(frame: WebSocketFrame, ctx: ConnectorContext): Promise<ConnectorEffect[]> {
		return handleSlackSocketMessage(frame, ctx);
	},

	async deliver(delivery: ChannelDelivery, ctx: ConnectorContext): Promise<ConnectorEffect[]> {
		return [buildSlackDeliveryEffect(delivery, ctx)];
	},
};

export default connector;
