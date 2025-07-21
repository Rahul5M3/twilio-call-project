
const twilio = require("twilio"); 

dotenv = require('dotenv');
dotenv.config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

async function createCall() {
  const call = await client.calls.create({
    from: "",
    to: "",
    // to: "+919315018206", // Replace with the recipient's phone number
    url: "", // Replace with your server URL
  });

  console.log(call.sid);
}

createCall();