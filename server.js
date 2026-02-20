const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const PORT = 3000;

// Early timestamp logging for webhooks (before body parsing)
app.use('/webhook', (req, res, next) => {
    req.receivedAt = new Date().toISOString();
    console.log(`[${req.receivedAt}] Webhook request received: ${req.method} ${req.url}`);
    next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve hold music from root directory
app.use('/hold-music', express.static(__dirname));

// In-memory state
const state = {
    queues: {
        sales: [],
        support: []
    },
    agents: new Map(), // agentId -> { name, status, currentCall, wsClient }
    signalwireCredentials: null // { spaceName, projectId, apiToken }
};

// Fetch call details from SignalWire API
async function fetchCallDetails(callId) {
    if (!state.signalwireCredentials) {
        console.log('No SignalWire credentials stored, cannot fetch call details');
        return null;
    }

    const { spaceName, projectId, apiToken } = state.signalwireCredentials;

    try {
        const response = await fetch(`https://${spaceName}/api/voice/logs/${callId}`, {
            method: 'GET',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${projectId}:${apiToken}`).toString('base64')
            }
        });

        if (!response.ok) {
            console.log(`Failed to fetch call details: ${response.status}`);
            return null;
        }

        const data = await response.json();
        console.log('Call details fetched for:', callId);
        return data;
    } catch (error) {
        console.error('Error fetching call details:', error.message);
        return null;
    }
}

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Broadcast to all connected agents
function broadcast(message) {
    const payload = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(payload);
        }
    });
}

// Get current state for new connections
function getFullState() {
    const agents = [];
    state.agents.forEach((agent, id) => {
        agents.push({
            id,
            name: agent.name,
            status: agent.status,
            currentCall: agent.currentCall
        });
    });

    return {
        type: 'full_state',
        queues: state.queues,
        agents
    };
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    let agentId = null;

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);

            switch (message.type) {
                case 'agent_join':
                    agentId = message.agentId;
                    state.agents.set(agentId, {
                        name: message.name,
                        status: 'available',
                        currentCall: null,
                        wsClient: ws
                    });
                    console.log(`Agent joined: ${message.name} (${agentId})`);

                    // Send full state to new agent
                    ws.send(JSON.stringify(getFullState()));

                    // Broadcast agent joined to all
                    broadcast({
                        type: 'agent_update',
                        agent: {
                            id: agentId,
                            name: message.name,
                            status: 'available',
                            currentCall: null
                        }
                    });
                    break;

                case 'agent_status':
                    if (agentId && state.agents.has(agentId)) {
                        const agent = state.agents.get(agentId);
                        agent.status = message.status;
                        agent.currentCall = message.currentCall || null;

                        broadcast({
                            type: 'agent_update',
                            agent: {
                                id: agentId,
                                name: agent.name,
                                status: agent.status,
                                currentCall: agent.currentCall
                            }
                        });
                    }
                    break;

                case 'request_state':
                    ws.send(JSON.stringify(getFullState()));
                    break;

                case 'set_credentials':
                    state.signalwireCredentials = {
                        spaceName: message.spaceName,
                        projectId: message.projectId,
                        apiToken: message.apiToken
                    };
                    console.log('SignalWire credentials stored for API calls');
                    break;
            }
        } catch (err) {
            console.error('WebSocket message error:', err);
        }
    });

    ws.on('close', () => {
        if (agentId && state.agents.has(agentId)) {
            const agent = state.agents.get(agentId);
            console.log(`Agent disconnected: ${agent.name} (${agentId})`);
            state.agents.delete(agentId);

            broadcast({
                type: 'agent_left',
                agentId
            });
        }
    });
});

// Webhook endpoint for SignalWire queue status callbacks
app.post('/webhook/queue-status', async (req, res) => {
    const event = req.body;

    // Handle SWML webhook format (params nested structure)
    const params = event.params || event;
    const queueName = params.name || params.queue_name || event.QueueName;
    const eventType = params.status || event.QueueResult || event.event;

    if (!queueName || !state.queues[queueName]) {
        console.log(`[${new Date().toISOString()}] Unknown queue: ${queueName}`);
        res.status(200).send('OK');
        return;
    }

    // Convert enqueue_ts from microseconds to ISO string if present
    let enqueuedAt = new Date().toISOString();
    if (params.enqueue_ts) {
        enqueuedAt = new Date(params.enqueue_ts / 1000).toISOString();
    }

    const callData = {
        callSid: params.call_id || params.control_id || event.CallSid,
        from: params.from || event.From || 'Unknown',
        to: params.to || event.To,
        queueSid: params.id || event.QueueSid,
        queueTime: params.avg_time || 0,
        queuePosition: params.position || 1,
        queueSize: params.size || 1,
        enqueuedAt: enqueuedAt
    };

    console.log(`[${new Date().toISOString()}] Processing ${eventType} event for queue ${queueName}, call ${callData.callSid}`);

    switch (eventType) {
        case 'enqueue':
        case 'bridged':
            // Check if call already exists in queue
            const existingIndex = state.queues[queueName].findIndex(
                c => c.callSid === callData.callSid
            );

            if (existingIndex === -1) {
                // Try to fetch call details for caller info
                if (callData.from === 'Unknown' && callData.callSid) {
                    const callDetails = await fetchCallDetails(callData.callSid);
                    if (callDetails) {
                        callData.from = callDetails.from || callDetails.caller_id_number || callData.from;
                        callData.to = callDetails.to || callDetails.destination_number || callData.to;
                    }
                }

                state.queues[queueName].push(callData);
                console.log(`[${new Date().toISOString()}] Call ${callData.callSid} added to ${queueName} queue (from: ${callData.from})`);

                broadcast({
                    type: 'call_enqueued',
                    queue: queueName,
                    call: callData
                });
            }
            break;

        case 'dequeue':
        case 'bridged-out':
            // Remove from queue
            const dequeueIndex = state.queues[queueName].findIndex(
                c => c.callSid === callData.callSid
            );

            if (dequeueIndex !== -1) {
                state.queues[queueName].splice(dequeueIndex, 1);
                console.log(`[${new Date().toISOString()}] Call ${callData.callSid} removed from ${queueName} queue (dequeued)`);

                broadcast({
                    type: 'call_dequeued',
                    queue: queueName,
                    callSid: callData.callSid
                });
            }
            break;

        case 'leave':
        case 'hangup':
        case 'timeout':
            // Caller left queue (hung up or timed out)
            const leaveIndex = state.queues[queueName].findIndex(
                c => c.callSid === callData.callSid
            );

            if (leaveIndex !== -1) {
                state.queues[queueName].splice(leaveIndex, 1);
                console.log(`[${new Date().toISOString()}] Call ${callData.callSid} left ${queueName} queue (${eventType})`);

                broadcast({
                    type: 'call_left',
                    queue: queueName,
                    callSid: callData.callSid,
                    reason: eventType
                });
            }
            break;

        default:
            console.log(`[${new Date().toISOString()}] Unhandled queue event type: ${eventType}`);
    }

    res.status(200).send('OK');
});

// Helper to get base URL from request (works with ngrok)
function getBaseUrl(req) {
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${protocol}://${host}`;
}

// SWML endpoint for inbound IVR
app.post('/swml/ivr', (req, res) => {
    const baseUrl = getBaseUrl(req);

    res.json({
        version: "1.0.0",
        sections: {
            main: [
                { answer: {} },
                {
                    prompt: {
                        play: "say:Welcome. Press 1 for Sales, or press 2 for Support.",
                        max_digits: 1,
                        initial_timeout: 10,
                        digit_timeout: 5
                    }
                },
                {
                    switch: {
                        variable: "prompt_value",
                        case: {
                            "1": [{ transfer: { dest: "sales_queue" } }],
                            "2": [{ transfer: { dest: "support_queue" } }]
                        },
                        default: [
                            { play: "say:Invalid selection. Goodbye." },
                            { hangup: {} }
                        ]
                    }
                }
            ],
            sales_queue: [
                { play: "say:Please hold while we connect you to sales." },
                {
                    enter_queue: {
                        queue_name: "sales",
                        status_url: `${baseUrl}/webhook/queue-status`,
                        // wait_url removed for testing - using SignalWire default hold music
                        wait_time: 3600,
                        transfer_after_bridge: `${baseUrl}/swml/hangup`
                    }
                }
            ],
            support_queue: [
                { play: "say:Please hold while we connect you to support." },
                {
                    enter_queue: {
                        queue_name: "support",
                        status_url: `${baseUrl}/webhook/queue-status`,
                        // wait_url removed for testing - using SignalWire default hold music
                        wait_time: 3600,
                        transfer_after_bridge: `${baseUrl}/swml/hangup`
                    }
                }
            ]
        }
    });
});

// SWML endpoint for agent connecting to queue
app.post('/swml/agent-connector', (req, res) => {
    const baseUrl = getBaseUrl(req);

    res.json({
        version: "1.0.0",
        sections: {
            main: [
                {
                    connect: {
                        to: "queue:%{vars.userVariables.queue_name}",
                        transfer_after_bridge: `${baseUrl}/swml/hangup`
                    }
                }
            ]
        }
    });
});

// SWML endpoint for post-bridge hangup
app.post('/swml/hangup', (req, res) => {
    res.json({
        version: "1.0.0",
        sections: {
            main: [
                { hangup: {} }
            ]
        }
    });
});

// Also support GET for hangup (for transfer_after_bridge URL)
app.get('/swml/hangup', (req, res) => {
    res.json({
        version: "1.0.0",
        sections: {
            main: [
                { hangup: {} }
            ]
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        queues: {
            sales: state.queues.sales.length,
            support: state.queues.support.length
        },
        agents: state.agents.size
    });
});

// Debug endpoint to view current state
app.get('/debug/state', (req, res) => {
    const agents = [];
    state.agents.forEach((agent, id) => {
        agents.push({
            id,
            name: agent.name,
            status: agent.status,
            currentCall: agent.currentCall
        });
    });

    res.json({
        queues: state.queues,
        agents
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           SignalWire Call Queue Server                     ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                   ║
║                                                            ║
║  Next steps:                                               ║
║  1. Run ngrok: ngrok http ${PORT}                             ║
║  2. Open http://localhost:${PORT} in your browser             ║
║  3. Enter your SignalWire credentials and ngrok URL        ║
║  4. Assign the IVR resource to your phone number           ║
╚════════════════════════════════════════════════════════════╝
    `);
});
