import express from "express";
import mongoose from  "mongoose";
import "dotenv/config";

const server = express();
let PORT = 3000;

let emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; // regex for email
let passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; // regex for password

server.use(express.json());

mongoose.connect(process.env.DB_LOCATION, {
  autoIndex: true
});

server.post("/sign-up", (req, res) => {
  let { fullname, email, password } = req.body;

  if(fullname.length < 3) {
    return res.status(403).json({ "error": "Full Name must be at least 3 letters long" })
  }

  if(!email.length) {
    return res.status(403).json({ "error": "Enter valid email" })
  }

  if(!emailRegex.test(email)) {
    return res.status(403).json({ "error": "Email is invalid" })
  }

  if(!passwordRegex.test(password)) {
    return res.status(403).json({ "error": "Password should be 6 to 20 characters long with a numeric, 1 lowercase and 1 uppercase letters" })
  }

  return res.status(200).json({ "status": "okay" });
})

server.listen(PORT, () => {
  console.log("listening on port => " + PORT);
});