package kalturaclient

type Param struct {
	key    string
	value  interface{}
	inBody bool
}

func KS(value string) Param {
	return Param{
		key:    "ks",
		value:  value,
		inBody: true,
	}
}

func Language(value string) Param {
	return Param{
		key:    "language",
		value:  value,
		inBody: true,
	}
}

func RequestId(value string) Param {
	return Param{
		key:    "x-kaltura-session-id",
		value:  value,
		inBody: false,
	}
}

func Currency (value string) Param {
	return Param{
		key:    "currency",
		value:  value,
		inBody: true,
	}
}

func UserId(value string) Param {
	return Param{
		key:    "userId",
		value:  value,
		inBody: true,
	}
}

func ResponseProfile(value interface{}) Param {
	return Param{
		key:    "responseProfile",
		value:  value,
		inBody: true,
	}
}
