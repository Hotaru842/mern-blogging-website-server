import express from "express";
import mongoose from  "mongoose";
import "dotenv/config";
import bcrypt from "bcrypt";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import cors from "cors";
import admin from "firebase-admin";
import serviceAccountKey from "./blog-website-fceb1-firebase-adminsdk-fbsvc-b29f7b3af7.json" with {type: "json" };
import { getAuth } from "firebase-admin/auth";
import aws from "aws-sdk";

import User from "./Schema/User.js";
import Blog from "./Schema/Blog.js";
import Notification from "./Schema/Notification.js";

const server = express();
let PORT = 3000;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountKey)
});

let emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; // regex for email
let passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; // regex for password

server.use(express.json());
server.use(cors());

mongoose.connect(process.env.DB_LOCATION, {
  autoIndex: true
});

// setting up s3 bucket
const s3 = new aws.S3({
  region: "us-east-2",
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const generateUploadURL = async () => {
  const date = new Date();
  const imageName = `${nanoid()}-${date.getTime()}.jpeg`;

  return await s3.getSignedUrlPromise("putObject", {
    Bucket: "ceci-blog-website",
    Key: imageName,
    Expires: 1000,
    ContentType: "image/jpeg",
  });
}

const verifyJWT = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if(token === null) {
    return res.status(401).json({ error: "No access token" });
  }

  jwt.verify(token, process.env.SECRET_ACCESS_KEY, (err, user) => {
    if(err) {
      return res.status(403).json({ error: "access token is invalid"})
    }

    req.user = user.id;
    next();
  })
}

const formatDataToSend = (user) => {
  const access_token = jwt.sign({ id: user._id }, process.env.SECRET_ACCESS_KEY);

  return {
    access_token,
    profile_img: user.personal_info.profile_img,
    username: user.personal_info.username,
    fullname: user.personal_info.fullname
  }
}

const generateUsername = async (email) => {
  let username = email.split("@")[0];

  let isUsernameNotUnique = await User.exists({ "personal_info.username": username })
    .then((result) => result);

  isUsernameNotUnique ? username += nanoid().substring(0, 5) : "";

  return username; 
}

// upload image URL route
server.get("/get-upload-url", (req, res) => {
  generateUploadURL().then(url => res.status(200).json({ uploadURL: url}))
  .catch((err) => {
    console.log(err.message);
    return res.status(500).json({ error: err.message });
  })
});

server.post("/sign-up", (req, res) => {
  let { fullname, email, password } = req.body;

  if(fullname.length < 3) {
    return res.status(403).json({ error: "Full Name must be at least 3 letters long" })
  }

  if(!email.length) {
    return res.status(403).json({ error: "Enter valid email" })
  }

  if(!emailRegex.test(email)) {
    return res.status(403).json({ error: "Email is invalid" })
  }

  if(!passwordRegex.test(password)) {
    return res.status(403).json({ error: "Password should be 6 to 20 characters long with a numeric, 1 lowercase and 1 uppercase letters" })
  }

  bcrypt.hash(password, 10, async (err, hashed_password) => {
    let username = await generateUsername(email);

    let user = new User({
      personal_info: { fullname, email, password: hashed_password, username }
    });

    user.save().then((u) => {
      return res.status(200).json(formatDataToSend(u));
    }).catch((err) => { 
      if(err.code == 11000) {
        return res.status(500).json({ error: "Email already exists" })
      }

      return res.status(500).json({ error: err.message });
    })
  })
});
 
server.post("/sign-in", (req, res) => {
  let { email, password } = req.body;

  User.findOne({ "personal_info.email": email })
  .then((user) => {
    if(!user) {
      return res.status(403).json({ error: "Email not found" })
    }

    if(!user.google_auth) {
      bcrypt.compare(password, user.personal_info.password, (err, result) => {
        if(err) {
          return res.status(403).json({ error: "Error ocurred while login, please try again"})
        }
  
        if(!result) {
          return res.status(403).json({ error: "Incorrect password" });
        } else {
          return res.status(200).json(formatDataToSend(user));
        }
      })
    } else {
      return res.status(403).json({ error: "Account was created using Google, try logging in with Google" });
    } 
  })
  .catch(err => {
    console.log(err.message);
    return res.status(500).json({ error: err.message })
  })
});

server.post("/google-auth", async (req, res) => {
  let { access_token } = req.body;

  getAuth().verifyIdToken(access_token)
  .then(async (decodedUser) => {
    let { email, name, picture } = decodedUser;

    picture = picture.replace("s96-c", "s384-c");

    let user = await User.findOne({ "personal_info.email": email })
    .select("personal_info.fullname personal_info.username personal_info.profile_img google_auth")
    .then((u) => {
      return u || null;
    })
    .catch((err) => {
      return res.status(500).json({ error: err.message })
    })

    if(user) {
      if(!user.google_auth) {
        return res.status(403).json({ error: "This email was signed up without Google. Please login with password to access this account" })
      }
    } else {
      let username = await generateUsername(email);

      user = new User({
        personal_info: { fullname: name, email, username },
        google_auth: true
      })

      await user.save().then((u) => {
        user = u;
      }).catch((err) => {
        return res.status(500).json({ error: err.message });
      })
    }

    return res.status(200).json(formatDataToSend(user));
  })
  .catch((err) => {
    return res.status(500).json({ error: "Fail to authenticate with Google. Try with another Google account" })
  })
});

server.post("/latest-blogs", (req, res) => {
  let { page } = req.body;

  let maxLimit = 5;

  Blog.find({ draft: false }).populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
  .sort({ "publishedAt": -1 })
  .select("blog_id title desc banner activity tags publishedAt -_id")
  .skip((page - 1) * maxLimit)
  .limit(maxLimit)
  .then(blogs => {
    return res.status(200).json({ blogs });
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
});

server.post("/all-latest-blogs-count", (req, res) => {
  Blog.countDocuments({ draft: false })
  .then((count) => {
    return res.status(200).json({ totalDocs: count });
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
})

server.get("/trending-blogs", (req, res) => {
  Blog.find({ draft: false })
  .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
  .sort({ "activity.total_reads": -1, "activity.total_likes": -1, "publishedAt": -1 })
  .select("blog_id title publishedAt -_id")
  .limit(5)
  .then(blogs => {
    return res.status(200).json({ blogs });
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
})

server.post("/search-blogs", (req, res) => {
  let { tag, query, author, page, limit, eliminate_blog } = req.body;

  let findQuery;

  if(tag) {
    findQuery = { tags: tag, draft: false, blog_id: { $ne: eliminate_blog } };
  } else if(query) {
    findQuery = { draft: false, title: new RegExp(query, "i") };
  } else if(author) {
    findQuery = { author, draft: false }
  }

  let maxLimit = limit ? limit : 5;
  
  Blog.find(findQuery).populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
  .sort({ "publishedAt": -1 })
  .select("blog_id title desc banner activity tags publishedAt -_id")
  .skip((page - 1) * maxLimit)
  .limit(maxLimit)
  .then(blogs => {
    return res.status(200).json({ blogs });
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
});

server.post("/search-blogs-count", (req, res) => {
  let { tag, author, query } = req.body;

  let findQuery;

  if(tag) {
    findQuery = { tags: tag, draft: false };
  } else if(query) {
    findQuery = { draft: false, title: new RegExp(query, "i") };
  } else if(author) {
    findQuery = { author, draft: false }
  }

  Blog.countDocuments(findQuery)
  .then(count => {
    return res.status(200).json({ totalDocs: count })
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
})

server.post("/search-users", (req, res) => {
  let { query } = req.body;

  User.find({ "personal_info.username": new RegExp(query, "i") })
  .limit(50)
  .select("personal_info.fullname personal_info.username personal_info.profile_img -_id")
  .then(users => {
    return res.status(200).json({ users });
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
})

server.post("/get-profile", (req, res) => {
  let { username } = req.body;

  User.findOne({ "personal_info.username": username })
  .select("-personal_info.password -google_auth -updatedAt -blogs")
  .then(user => {
    return res.status(200).json(user);
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
})

server.post("/create-blog", verifyJWT, (req, res) => { 
  let authorId = req.user;

  let { title, banner, desc, tags, content, draft, id } = req.body;

  if(!title.length) {
    return res.status(403).json({ error: "You must provide a title"})
  }

  if(!draft) {
    if(!desc.length || desc.length > 200) {
      return res.status(403).json({ error: "You must provide a blog description under 200 characters"})
    }
  
    if(!banner.length) {
      return res.status(403).json({ error: "You must provide blog banner to publish it" })
    }
  
    if(!content.blocks.length) {
      return res.status(403).json({ error: "There must be some blog content to publish it" })
    }
  
    if(!tags.length || tags.length > 10) {
      return res.status(403).json({ error: "Provide tags to publish it, max 10 tags" })
    }  
  }
  
  tags = tags.map((tag) => tag.toLowerCase());
  let blog_id = id || title.replace(/[^a-zA-Z0-9]/g, " ").replace(/\s+/g, "-").trim() + nanoid();
  
  if(id) {
    Blog.findOneAndUpdate({ blog_id }, { title, desc, banner, content, tags, draft: Boolean(draft) })
    .then(() => {
      return res.status(200).json({ id: blog_id })
    })
    .catch(err => {
      return res.status(500).json({ error: err.message });
    })
  } else {
    let blog = new Blog({
      title, 
      banner,
      desc,
      tags,
      content,
      author: authorId,
      blog_id,
      draft: Boolean(draft)
    });
  
    blog.save().then(blog => {
      let incrementVal = draft ? 0 : 1;
  
      User.findOneAndUpdate({ _id: authorId }, { $inc: { "account_info.total_posts": incrementVal }, $push: { "blogs": blog._id }})
      .then(user => {
        return res.status(200).json({ id: blog.blog_id})
      }).catch((err) => {
        return res.status(500).json({ error: "Failed to update total posts number" })
      })
    }).catch((err) => {
      return res.status(500).json({ error: err.message });
    });
  }
});

server.post("/get-blog", (req, res) => {
  let { blog_id, draft, mode } = req.body;
  let incrementVal = mode !== "edit" ? 1 : 0; 

  Blog.findOneAndUpdate({ blog_id }, { $inc: { "activity.total_reads": incrementVal }})
  .populate("author", "personal_info.fullname personal_info.username personal_info.profile_img")
  .select("title desc content banner activity publishedAt blog_id tags")
  .then(blog => {
    User.findOneAndUpdate({ "personal_info.username": blog.author.personal_info.username }, {
      $inc: { "account_info.total_reads": incrementVal }
    })
    .catch(err => {
      return res.status(500).json({ error: err.message });
    })

    if(blog.draft && !draft) {
      return res.status(500).json({ error: "You can't access draft blogs" })
    }

    return res.status(200).json({ blog });
  })
  .catch(err => {
    return res.status(500).json({ error: err.message });
  })
}); 

server.post("/like-blog", verifyJWT, (req, res) => {
  let user_id = req.user;

  let { _id, isLikedByUser } = req.body;

  let incrementVal = !isLikedByUser ? 1 : isLikedByUser > 0 ? -1 : 0;

  Blog.findOneAndUpdate({ _id }, { $inc: { "activity.total_likes": incrementVal }})
  .then(blog => {
    if(!isLikedByUser) {
      let like = new Notification({
        type: "like",
        blog: _id,
        notification_for: blog.author,
        user: user_id,
      });

      like.save().then(notification => {
        return res.status(200).json({ liked_by_user: true })
      })
    }
  })
});

server.listen(PORT, () => {
  console.log("listening on port => " + PORT);
});