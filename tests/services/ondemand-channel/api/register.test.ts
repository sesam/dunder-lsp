import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock, BufferWritableMock } from "stream-mock";

import { routerrpc } from "../../../../src/proto";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";
import build from "../../../../src/app";
import { bytesToHexString, sha256Buffer, timeout } from "../../../../src/utils/common";

// Mocked functions
import { openChannelSync } from "../../../../mocks/utils/lnd-api";
import { createForwardHtlcInterceptRequest, sendRegisterRequest } from "./register-helpers";

describe("/ondemand-channel/register", () => {
  test("registers and opens a channel when the HTLC are settled (non-MPP)", async (done) => {
    const app = build();

    const amountSat = 10000;
    const preimage = new Uint8Array([0]);
    const paymentHash = sha256Buffer(preimage);
    const pubkey = "abcdef12345";
    const signature = "validsig";
    const htlcPart = Long.fromValue(123);

    const response = await sendRegisterRequest(app, {
      amountSat,
      preimage: bytesToHexString(preimage),
      pubkey,
      signature,
    });
    expect(response.statusCode).toBe(200);
    const registerResponse = response.json() as IRegisterOkResponse;

    const htlcInterceptorStream: DuplexMock = require("../../../../src/utils/lnd-api")
      .__htlcInterceptorStream;
    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        amountSat,
        registerResponse.fakeChannelId,
        paymentHash,
        htlcPart,
      ),
    );
    let forwardHtlcInterceptResponse: routerrpc.ForwardHtlcInterceptResponse | null = null;
    // Replace the write function so we can spy on the response
    htlcInterceptorStream.write = (data: any) => {
      const r = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      if (r.incomingCircuitKey?.chanId?.eq(registerResponse.fakeChannelId)) {
        forwardHtlcInterceptResponse = r;
      }
      return true;
    };

    await timeout(500);

    const subscribeHtlcEventsStream: BufferWritableMock = require("../../../../src/utils/lnd-api")
      .__subscribeHtlcEventsStream;
    subscribeHtlcEventsStream.emit(
      "data",
      routerrpc.HtlcEvent.encode({
        eventType: routerrpc.HtlcEvent.EventType.FORWARD,
        settleEvent: {},
        outgoingChannelId: Long.fromValue(registerResponse.fakeChannelId),
        incomingHtlcId: htlcPart,
      }).finish(),
    );

    await waitForExpect(async () => {
      expect(forwardHtlcInterceptResponse?.action).toBe(routerrpc.ResolveHoldForwardAction.SETTLE);
      expect(openChannelSync).toBeCalled();
    });

    await timeout(500);

    app.close();
    done();
  });
});
