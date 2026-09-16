const jwt = require('jsonwebtoken');

// Every protected route reads req.userId / req.companyId / req.role from
// here instead of trusting a companyId passed in the request body or query
// string, which is what every route did before this — anyone could claim to
// be any company. This is the actual fix, not just an added login screen.
module.exports = function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    req.companyId = payload.companyId;
    req.role = payload.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
